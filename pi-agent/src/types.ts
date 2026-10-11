export type HarnessAction = "clarify" | "generate_cases" | "evaluate" | "diagnose" | "status";

export interface ProjectContext {
  id: number;
  name: string;
  agent_type: string;
  background: string;
  capabilities: string;
  boundaries: string;
  scoring_standard: string;
}

export interface HarnessInput {
  action: HarnessAction;
  project?: ProjectContext;
  run?: Record<string, unknown>;
  mode?: "mock" | "live";
  judgeModel?: { id: string; name: string; base_url: string; model_id: string; api_key: string };
}

export interface ProposedCase {
  code: string;
  category: string;
  title: string;
  query: string;
  expected_answer: string;
  expected_keywords: string[];
  forbidden_keywords: string[];
  followups: string[];
  max_turns: number;
  priority: "P0" | "P1" | "P2";
}

export interface HarnessTrace {
  runtime: "pi-agent-core";
  mode: "mock" | "live";
  provider: string;
  model: string;
  duration_ms: number;
  turns: number;
  tool_calls: Array<{ name: string; status: "started" | "completed" | "failed" }>;
}

export interface HarnessOutput {
  ok: boolean;
  action: HarnessAction;
  questions?: Array<{ field: string; question: string }>;
  cases?: ProposedCase[];
  diagnosis?: { category: string; root_cause: string; suggestion: string; confidence: number };
  evaluation?: {
    score: number; passed: boolean; capability_matches: string[]; missing_capabilities: string[];
    hallucinations: string[]; evidence: string[]; reason: string;
  };
  message?: string;
  trace?: HarnessTrace;
  configured?: boolean;
  error?: string;
}
