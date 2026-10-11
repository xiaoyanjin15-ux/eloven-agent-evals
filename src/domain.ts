export interface Project {
  id: number;
  project_key: string;
  name: string;
  agent_type: "dialogue" | "ppt";
  background: string;
  capabilities: string;
  boundaries: string;
  scoring_standard: string;
  status: string;
  target_adapter: TargetAdapter;
  target_base_url: string;
  target_agent_id: string;
  target_profile: string;
  source_workbook_path: string;
  source_workbook_name: string;
  evidence_master_batch_id: number;
  created_at: string;
  updated_at: string;
  summary?: ProjectSummary;
}

export interface EvalCase {
  id: number;
  project_id: number;
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
  approved: number;
  execution_type: "dialogue" | "browser" | "hybrid";
  start_url: string;
  browser_steps: BrowserStep[];
  source_sheet_name: string;
  source_case_code: string;
  source_row_number: number;
  office_industry: string;
  office_subindustry: string;
  office_role: string;
  office_key: string;
  office_name: string;
  case_type: "single_turn" | "multi_turn";
  conversation_group: string;
  conversation_round: number;
  input_mode: "message" | "topic_click";
  evaluation_criteria: string;
  source_fields: Record<string, unknown>;
  expected_trace: { required_tools: string[]; forbidden_tools: string[]; ordered: boolean; parameter_constraints: string; max_tool_calls: number | null; notes: string };
  created_at: string;
  updated_at: string;
}

export interface EvaluationSet {
  id: number;
  project_id: number;
  name: string;
  description: string;
  source: "manual" | "excel" | "generated" | "migration";
  status: "draft" | "published" | "archived";
  case_count?: number;
  approved_count?: number;
  created_at: string;
  updated_at: string;
}

export interface OfficeMapping {
  project_id: number;
  office_key: string;
  generated_name: string;
  actual_office_name: string;
  actual_office_url: string;
  created_at: string;
  updated_at: string;
}

export interface OfficePlan extends OfficeMapping {
  cases: EvalCase[];
}

export interface ScoreDetail {
  score: number;
  passed: boolean;
  dimensions: Record<string, number>;
  matched_keywords: string[];
  missing_keywords: string[];
  violations: string[];
  reasons: string[];
  pi_diagnosis?: Record<string, unknown>;
  semantic_evaluation?: {
    capability_matches: string[]; missing_capabilities: string[]; hallucinations: string[];
    evidence: string[]; reason: string; evaluator_mode?: string;
  };
}

export interface ProjectSummary {
  cases: { total: number; approved: number };
  runs: { total: number; passed: number; pass_rate: number; avg_score: number; avg_latency: number };
}

export interface AgentReply {
  content: string;
  tool_calls: Array<Record<string, unknown>>;
}

export interface DialogueAgent {
  reset(evalCase: EvalCase): Promise<void> | void;
  reply(messages: Array<{ role: string; content: string }>): Promise<AgentReply>;
}

export type TargetAdapter = "mock" | "office_agent" | "openai_compatible" | "browser";
export type WorkflowMode = "live_eval" | "collect_first";

export interface BrowserStep {
  action: "navigate" | "click" | "fill" | "select" | "wait" | "assert_text" | "screenshot";
  target?: string;
  value?: string;
  description?: string;
}

export interface OfficeAgentConfig {
  base_url: string;
  agent_id: string;
  profile?: string;
  jwt?: string;
  model?: string;
  session_id?: string;
}
