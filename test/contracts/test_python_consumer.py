"""Conformidade offline do consumidor Python. Não inicia Telegram, OAuth ou MCP."""

import copy
import json
from pathlib import Path
import unittest

from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[2]
CONTRACT = ROOT / "contracts" / "conversation" / "v1"
EXAMPLES = json.loads((CONTRACT / "examples.json").read_text(encoding="utf-8"))
VALIDATORS = {
    name: Draft202012Validator(
        json.loads((CONTRACT / f"{name}.schema.json").read_text(encoding="utf-8")),
        format_checker=FormatChecker(),
    )
    for name in ("event", "approval", "cancel", "cancelResult", "snapshot", "operation", "error", "change", "modelContext")
}


def example(name):
    return copy.deepcopy(next(e["value"] for e in EXAMPLES if e["name"] == name))


class MockConsumer:
    """Mock de adaptador com transporte injetado; outbox durável pertence a BOT-01."""

    def __init__(self, transport, *, token, organizer_id, bot_id):
        self.transport = transport
        self.token = token
        self.organizer_id = organizer_id
        self.bot_id = bot_id
        self.pending = {}

    def prepare(self, update, expected_version):
        # update vem do polling autenticado. Nunca aceitar metadados de origem do LLM.
        message = update["message"]
        chat = message["chat"]
        sender = str(message["from"]["id"])
        if chat["type"] != "private" or sender != self.organizer_id or str(chat["id"]) != sender:
            raise ValueError("identidade/conversa não permitida")
        event = {
            "contractVersion": "1.0",
            "eventId": f"tg-update-{update['update_id']}",
            "conversationId": sender,
            "expectedVersion": expected_version,
            "source": {
                "channel": "TELEGRAM", "botId": self.bot_id, "conversationId": sender,
                "kind": "MESSAGE", "messageId": str(message["message_id"]),
            },
            "input": {"kind": "TEXT", "text": message["text"]},
        }
        VALIDATORS["event"].validate(event)
        previous = self.pending.get(event["eventId"])
        if previous is not None and previous != event:
            raise ValueError("evento já preparado com outro conteúdo")
        self.pending[event["eventId"]] = copy.deepcopy(event)
        return event["eventId"]

    def send(self, event_id):
        # Em timeout, o chamador conserva este evento. Não recriar updateId, versão ou payload.
        event = copy.deepcopy(self.pending[event_id])
        status, response = self.transport(
            f"/api/bot/v1/conversations/{event['conversationId']}/events",
            {
                "Authorization": f"Bearer {self.token}",
                "X-Telegram-User-Id": self.organizer_id,
                "X-Telegram-Chat-Id": self.organizer_id,
            },
            event,
        )
        if status in (200, 202):
            VALIDATORS["operation"].validate(response)
            if response["conversationId"] != event["conversationId"] or response["eventId"] != event_id:
                raise ValueError("resposta de outro evento/conversa")
        else:
            VALIDATORS["error"].validate(response)
        return status, response


class ContractTests(unittest.TestCase):
    def test_json_schemas_and_shared_examples(self):
        for validator in VALIDATORS.values():
            validator.check_schema(validator.schema)
        for case in EXAMPLES:
            with self.subTest(case=case["name"]):
                self.assertEqual(VALIDATORS[case["schema"]].is_valid(case["value"]), case["valid"])

    def update(self):
        return {"update_id": 500, "message": {"message_id": 30,
                "from": {"id": 111111111}, "chat": {"type": "private", "id": 111111111},
                "text": example("evento de texto")["input"]["text"]}}

    def consumer(self, transport):
        return MockConsumer(transport, token="synthetic-token", organizer_id="111111111", bot_id="900001")

    def test_timeout_then_replay_preserves_exact_origin_and_event(self):
        calls = []

        def transport(path, headers, body):
            calls.append((path, headers, copy.deepcopy(body)))
            if len(calls) == 1:
                raise TimeoutError("resposta perdida após aceitação simulada")
            return 200, example("operação aceita")

        client = self.consumer(transport)
        key = client.prepare(self.update(), 0)
        with self.assertRaises(TimeoutError):
            client.send(key)
        client.send(key)
        self.assertEqual(calls[0], calls[1])
        self.assertEqual(calls[0][2], example("evento de texto"))
        self.assertNotIn("approvalRef", json.dumps(calls[0][2]))

    def test_conflict_and_stale_version_are_explicit_without_automatic_retry(self):
        for name in ("erro EVENT_CONFLICT", "erro STALE_VERSION"):
            calls = []

            def transport(*args):
                calls.append(args)
                return 409, example(name)

            client = self.consumer(transport)
            key = client.prepare(self.update(), 0)
            status, response = client.send(key)
            self.assertEqual(status, 409)
            self.assertEqual(response["error"]["code"], name.removeprefix("erro "))
            self.assertEqual(len(calls), 1)

    def test_invalid_identity_never_calls_transport(self):
        def forbidden_transport(*_args):
            self.fail("identidade inválida chegou ao transporte")

        for field, value in (("from", {"id": 222222222}), ("chat", {"id": 111111111, "type": "group"})):
            update = self.update()
            update["message"][field] = value
            with self.assertRaises(ValueError):
                self.consumer(forbidden_transport).prepare(update, 0)

    def test_changed_payload_cannot_reuse_prepared_event(self):
        client = self.consumer(lambda *_: None)
        client.prepare(self.update(), 0)
        changed = self.update()
        changed["message"]["text"] = "outro conteúdo"
        with self.assertRaises(ValueError):
            client.prepare(changed, 0)

    def test_response_of_another_conversation_is_rejected(self):
        response = example("operação aceita")
        response["conversationId"] = "222222222"
        client = self.consumer(lambda *_: (202, response))
        key = client.prepare(self.update(), 0)
        with self.assertRaises(ValueError):
            client.send(key)


if __name__ == "__main__":
    unittest.main()
