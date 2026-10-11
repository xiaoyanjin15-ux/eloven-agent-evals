import assert from "node:assert/strict";
import test from "node:test";

import { planConversationTurn } from "./conversation-plan.js";

test("multi-turn cases reuse one conversation until the group changes", () => {
  const base = { office_key: "office-a", case_type: "multi_turn" as const, conversation_group: "M01" };
  const first = planConversationTurn({ ...base, conversation_round: 1 }, "");
  assert.equal(first.newConversation, true);
  const second = planConversationTurn({ ...base, conversation_round: 2 }, first.nextGroup);
  assert.equal(second.newConversation, false);
  const third = planConversationTurn({ ...base, conversation_round: 3 }, second.nextGroup);
  assert.equal(third.newConversation, false);
  const nextGroup = planConversationTurn({ ...base, conversation_group: "M02", conversation_round: 1 }, third.nextGroup);
  assert.equal(nextGroup.newConversation, true);
  const ordinary = planConversationTurn({ ...base, case_type: "single_turn", conversation_group: "", conversation_round: 1 }, nextGroup.nextGroup);
  assert.deepEqual(ordinary, { newConversation: true, nextGroup: "" });
});
