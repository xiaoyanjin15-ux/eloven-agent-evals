export interface ConversationTurnIdentity {
  office_key: string;
  case_type: "single_turn" | "multi_turn";
  conversation_group: string;
  conversation_round: number;
}

export function planConversationTurn(item: ConversationTurnIdentity, activeGroup: string): { newConversation: boolean; nextGroup: string } {
  if (item.case_type !== "multi_turn") return { newConversation: true, nextGroup: "" };
  const nextGroup = `${item.office_key}:${item.conversation_group}`;
  return { newConversation: activeGroup !== nextGroup || item.conversation_round <= 1, nextGroup };
}
