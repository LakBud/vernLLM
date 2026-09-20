export interface TextPart {
  type: 'text';
  content: string;
}
export interface ToolCallPart {
  type: 'tool_call';
  id?: string;
  name: string;
  arguments?: unknown;
}
export interface ToolCallResponsePart {
  type: 'tool_call_response';
  id?: string;
  response?: string;
}
export type Part = TextPart | ToolCallPart | ToolCallResponsePart;

export interface InputMessage {
  role: 'user' | 'assistant' | 'tool';
  parts: Part[];
}

export interface CapturedInput {
  inputMessages?: string;
  systemInstructions?: string;
  toolDefinitions?: string;
}
