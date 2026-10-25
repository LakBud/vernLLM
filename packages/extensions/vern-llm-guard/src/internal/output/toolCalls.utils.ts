import type { StreamChunk } from 'vern-llm';

/** A tool call as it arrives: its arguments are held until the call is complete. */
export interface OpenCall {
  id?: string;
  name?: string;
  args: string;
}

type ToolDelta = Extract<StreamChunk, { type: 'tool_call_delta' }>;

/** Folds one delta into the call it belongs to, starting the call if it is new. */
export function mergeDelta(calls: Map<number, OpenCall>, chunk: ToolDelta): void {
  const call = calls.get(chunk.index) ?? { args: '' };
  if (chunk.id !== undefined) call.id = chunk.id;
  if (chunk.name !== undefined) call.name = chunk.name;
  if (chunk.argsDelta !== undefined) {
    call.args = chunk.complete === true ? chunk.argsDelta : call.args + chunk.argsDelta;
  }
  calls.set(chunk.index, call);
}

/** The one chunk a finished call goes out as, with its checked arguments. */
export function toolChunk(index: number, call: OpenCall, args: string): StreamChunk {
  return {
    type: 'tool_call_delta',
    index,
    ...(call.id !== undefined && { id: call.id }),
    ...(call.name !== undefined && { name: call.name }),
    argsDelta: args,
    complete: true,
  };
}
