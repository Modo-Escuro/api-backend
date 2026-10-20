export interface JsonModelRequest<Input> {
  input: Input;
  signal: AbortSignal;
  maxOutputTokens: number;
  budgetScope?: string;
  reportUsage?(usage: { inputTokens?: number; outputTokens?: number; costMicroUsd?: number }): void;
}
export interface JsonConversationModel<Input, Result> {
  readonly id: string;
  propose(request: JsonModelRequest<Input>): Promise<Result>;
}
