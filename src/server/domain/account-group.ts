// Cadastro independente da compra. Apenas dados declarados; sem catálogo, endereço ou aprovação.
import { PurchaseStateSchema, type PurchaseState } from './purchase.js';

export const AccountGroupSchema = PurchaseStateSchema.pick({ participants: true, groupLimit: true, priority: true, clarifications: true });
export function groupOf(state: PurchaseState) {
  const { participants, groupLimit, priority, clarifications } = state;
  return AccountGroupSchema.parse({ participants, groupLimit, priority,
    clarifications: clarifications.filter(c => ['RESTRICTIONS', 'LIMIT', 'PRIORITY'].includes(c.field)) });
}
