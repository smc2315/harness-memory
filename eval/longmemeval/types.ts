/**
 * LongMemEval Dataset Types
 *
 * Based on: https://github.com/xiaowu0162/LongMemEval
 * Paper: https://arxiv.org/abs/2410.10813 (ICLR 2025)
 * Dataset: https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned
 */

export type QuestionType =
  | "single-session-user"
  | "single-session-assistant"
  | "single-session-preference"
  | "temporal-reasoning"
  | "knowledge-update"
  | "multi-session";

export type Capability =
  | "information_extraction"
  | "multi_session_reasoning"
  | "temporal_reasoning"
  | "knowledge_updates"
  | "abstention";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Present on evidence turns — indicates this turn contains answer */
  has_answer?: boolean;
}

export type Session = ChatMessage[];

export interface LongMemEvalQuestion {
  question_id: string;
  question_type: QuestionType;
  question: string;
  answer: string;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: Session[];
  answer_session_ids: string[];
}

export interface EvalResult {
  question_id: string;
  question_type: QuestionType;
  capability: Capability;
  is_abstention: boolean;
  hypothesis: string;
  judgment: "correct" | "incorrect" | "error";
  retrieval_session_ids: string[];
  session_recall: number;
}

export interface EvalSummary {
  total: number;
  correct: number;
  accuracy: number;
  by_capability: Record<Capability, { total: number; correct: number; accuracy: number }>;
  by_question_type: Record<QuestionType, { total: number; correct: number; accuracy: number }>;
  abstention_accuracy: number;
}

/** Maps LongMemEval question_type to capability category */
export function questionTypeToCapability(qt: QuestionType, isAbstention: boolean): Capability {
  if (isAbstention) return "abstention";
  switch (qt) {
    case "single-session-user":
    case "single-session-assistant":
    case "single-session-preference":
      return "information_extraction";
    case "multi-session":
      return "multi_session_reasoning";
    case "temporal-reasoning":
      return "temporal_reasoning";
    case "knowledge-update":
      return "knowledge_updates";
    default:
      return "information_extraction";
  }
}
