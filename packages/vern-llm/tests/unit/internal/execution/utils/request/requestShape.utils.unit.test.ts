import { describe, expect, it } from 'vitest';

import {
  buildResponseFormat,
  buildWireToolChoice,
  resolveJsonMode,
  serializeAssistantContent,
  turnToWireMessages,
  validateHistory,
  validateTools,
} from '../../../../../../src/internal/execution/utils/request/requestShape.utils.js';

import type { ConversationTurn, ToolDefinition } from '../../../../../../src/types/index.js';

function tool(name: string): ToolDefinition {
  return { name, description: 'a tool', parameters: {} };
}

describe('validateTools', () => {
  it('does not throw for no tools and no toolChoice', () => {
    expect(() => validateTools(undefined, undefined)).not.toThrow();
  });

  it('does not throw for a valid, non-empty tools array with no toolChoice', () => {
    expect(() => validateTools([tool('a'), tool('b')], undefined)).not.toThrow();
  });

  it('throws invalid_params for an empty tools array', () => {
    expect(() => validateTools([], undefined)).toThrow(
      expect.objectContaining({ type: 'invalid_params' }),
    );
  });

  it('throws for duplicate tool names, naming every duplicate', () => {
    try {
      validateTools([tool('a'), tool('b'), tool('a')], undefined);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toMatchObject({
        type: 'invalid_params',
        code: 'duplicate_tool_names',
        issues: { names: ['a'] },
      });
    }
  });

  it('throws when toolChoice is set without tools', () => {
    expect(() => validateTools(undefined, 'required')).toThrow(
      expect.objectContaining({ type: 'invalid_params' }),
    );
  });

  it('does not throw for a string toolChoice ("auto"/"none"/"required") with tools set', () => {
    expect(() => validateTools([tool('a')], 'auto')).not.toThrow();
    expect(() => validateTools([tool('a')], 'none')).not.toThrow();
    expect(() => validateTools([tool('a')], 'required')).not.toThrow();
  });

  it('does not throw when toolChoice names a real tool', () => {
    expect(() => validateTools([tool('a'), tool('b')], { name: 'b' })).not.toThrow();
  });

  it('throws when toolChoice names a tool that is not in tools', () => {
    try {
      validateTools([tool('a')], { name: 'missing' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toMatchObject({
        type: 'invalid_params',
        code: 'unknown_tool_choice',
        issues: { requested: 'missing', available: ['a'] },
      });
    }
  });
});

describe('resolveJsonMode, defaults', () => {
  it('defaults to true (JSON) when jsonMode is unset and there are no tools', () => {
    expect(
      resolveJsonMode({
        jsonModeExplicit: undefined,
        hasTools: false,
        jsonSchema: undefined,
        hasSchema: false,
        supportsJsonObjectMode: true,
      }),
    ).toBe(true);
  });

  it('defaults to false (plain text) when jsonMode is unset and tools are present', () => {
    expect(
      resolveJsonMode({
        jsonModeExplicit: undefined,
        hasTools: true,
        jsonSchema: undefined,
        hasSchema: false,
        supportsJsonObjectMode: true,
      }),
    ).toBe(false);
  });

  it('honors an explicit jsonMode over the tools-based default', () => {
    expect(
      resolveJsonMode({
        jsonModeExplicit: true,
        hasTools: true,
        jsonSchema: undefined,
        hasSchema: false,
        supportsJsonObjectMode: true,
      }),
    ).toBe(true);

    expect(
      resolveJsonMode({
        jsonModeExplicit: false,
        hasTools: false,
        jsonSchema: undefined,
        hasSchema: false,
        supportsJsonObjectMode: true,
      }),
    ).toBe(false);
  });
});

describe('resolveJsonMode, jsonSchema bypasses supportsJsonObjectMode entirely', () => {
  it('resolves true when jsonSchema is set, even on a client that cannot support json_object mode', () => {
    expect(
      resolveJsonMode({
        jsonModeExplicit: undefined,
        hasTools: false,
        jsonSchema: { name: 's', schema: {} },
        hasSchema: false,
        supportsJsonObjectMode: false,
      }),
    ).toBe(true);
  });
});

describe('resolveJsonMode, unsupported client (supportsJsonObjectMode: false)', () => {
  it('throws when jsonMode: true is explicit and there is no jsonSchema', () => {
    expect(() =>
      resolveJsonMode({
        jsonModeExplicit: true,
        hasTools: false,
        jsonSchema: undefined,
        hasSchema: false,
        supportsJsonObjectMode: false,
      }),
    ).toThrow(expect.objectContaining({ type: 'invalid_params' }));
  });

  it('throws when schema is set, jsonMode is unset, and there is no jsonSchema', () => {
    expect(() =>
      resolveJsonMode({
        jsonModeExplicit: undefined,
        hasTools: false,
        jsonSchema: undefined,
        hasSchema: true,
        supportsJsonObjectMode: false,
      }),
    ).toThrow(expect.objectContaining({ type: 'invalid_params' }));
  });

  it('silently downgrades to plain text when jsonMode is unset and there is no schema or jsonSchema', () => {
    expect(
      resolveJsonMode({
        jsonModeExplicit: undefined,
        hasTools: false,
        jsonSchema: undefined,
        hasSchema: false,
        supportsJsonObjectMode: false,
      }),
    ).toBe(false);
  });

  it('does not throw for explicit jsonMode: false, even with schema set (schema-without-useJson check catches that instead)', () => {
    // jsonMode: false + schema is invalid, but for a different reason
    // (see the next describe block); this block only covers the
    // supportsJsonObjectMode-specific throws.
    expect(() =>
      resolveJsonMode({
        jsonModeExplicit: false,
        hasTools: false,
        jsonSchema: undefined,
        hasSchema: false,
        supportsJsonObjectMode: false,
      }),
    ).not.toThrow();
  });
});

describe('resolveJsonMode, schema without useJson', () => {
  it('throws when schema is set but the resolved mode is not JSON', () => {
    expect(() =>
      resolveJsonMode({
        jsonModeExplicit: false,
        hasTools: false,
        jsonSchema: undefined,
        hasSchema: true,
        supportsJsonObjectMode: true,
      }),
    ).toThrow(expect.objectContaining({ type: 'invalid_params' }));
  });

  it('does not throw when schema is set and jsonMode resolves to true', () => {
    expect(() =>
      resolveJsonMode({
        jsonModeExplicit: true,
        hasTools: false,
        jsonSchema: undefined,
        hasSchema: true,
        supportsJsonObjectMode: true,
      }),
    ).not.toThrow();
  });
});

describe('buildResponseFormat', () => {
  it('returns undefined when useJson is false and there is no jsonSchema', () => {
    expect(buildResponseFormat(undefined, false)).toBeUndefined();
  });

  it('returns json_object when useJson is true and there is no jsonSchema', () => {
    expect(buildResponseFormat(undefined, true)).toEqual({ type: 'json_object' });
  });

  it('returns json_schema, defaulting strict to true, when jsonSchema is given', () => {
    expect(buildResponseFormat({ name: 'x', schema: { type: 'object' } }, false)).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'x',
        schema: { type: 'object' },
        strict: true,
        description: undefined,
      },
    });
  });

  it('honors an explicit strict: false on jsonSchema', () => {
    const format = buildResponseFormat({ name: 'x', schema: {}, strict: false }, false);

    expect(format).toMatchObject({ json_schema: { strict: false } });
  });

  it('prioritizes jsonSchema over useJson: false', () => {
    expect(buildResponseFormat({ name: 'x', schema: {} }, false)).toMatchObject({
      type: 'json_schema',
    });
  });
});

describe('buildWireToolChoice', () => {
  it('maps undefined and "auto" to "auto"', () => {
    expect(buildWireToolChoice(undefined)).toBe('auto');
    expect(buildWireToolChoice('auto')).toBe('auto');
  });

  it('passes "none" and "required" through unchanged', () => {
    expect(buildWireToolChoice('none')).toBe('none');
    expect(buildWireToolChoice('required')).toBe('required');
  });

  it('maps a named tool choice to the OpenAI-shaped function wire object', () => {
    expect(buildWireToolChoice({ name: 'my_tool' })).toEqual({
      type: 'function',
      function: { name: 'my_tool' },
    });
  });
});

describe('serializeAssistantContent', () => {
  it('passes a string through unchanged', () => {
    expect(serializeAssistantContent('hello')).toBe('hello');
  });

  it('JSON.stringifies non-string content', () => {
    expect(serializeAssistantContent({ a: 1 })).toBe('{"a":1}');
  });
});

describe('turnToWireMessages, user turn', () => {
  it('maps a user turn 1:1', () => {
    expect(turnToWireMessages({ role: 'user', content: 'hi' })).toEqual([
      { role: 'user', content: 'hi' },
    ]);
  });
});

describe('turnToWireMessages, assistant turn', () => {
  it('maps a plain assistant turn, serializing content', () => {
    expect(turnToWireMessages({ role: 'assistant', content: 'hi there' })).toEqual([
      { role: 'assistant', content: 'hi there' },
    ]);
  });

  it('defaults missing assistant content to an empty string', () => {
    expect(turnToWireMessages({ role: 'assistant' })).toEqual([{ role: 'assistant', content: '' }]);
  });

  it('maps an assistant turn with toolCalls to wire tool_calls, omitting content when unset', () => {
    const messages = turnToWireMessages({
      role: 'assistant',
      toolCalls: [{ id: 'c1', name: 'search', arguments: { q: 'x' } }],
    });

    expect(messages).toEqual([
      {
        role: 'assistant',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } },
        ],
      },
    ]);
  });

  it('includes content alongside toolCalls when the assistant turn set both', () => {
    const messages = turnToWireMessages({
      role: 'assistant',
      content: 'let me check',
      toolCalls: [{ id: 'c1', name: 'search', arguments: {} }],
    });

    expect(messages[0]).toMatchObject({ content: 'let me check' });
  });
});

describe('turnToWireMessages, tool turn', () => {
  it('expands one toolResult per wire tool message', () => {
    const messages = turnToWireMessages({
      role: 'tool',
      toolResults: [
        { toolCallId: 'c1', content: 'result 1' },
        { toolCallId: 'c2', content: { ok: true } },
      ],
    });

    expect(messages).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: 'result 1' },
      { role: 'tool', tool_call_id: 'c2', content: '{"ok":true}' },
    ]);
  });

  it('includes is_error only when the toolResult set it', () => {
    const messages = turnToWireMessages({
      role: 'tool',
      toolResults: [{ toolCallId: 'c1', content: 'boom', isError: true }],
    });

    expect(messages[0]).toMatchObject({ is_error: true });
  });

  it('maps a null/undefined content to the string "null"', () => {
    const messages = turnToWireMessages({
      role: 'tool',
      toolResults: [{ toolCallId: 'c1', content: undefined }],
    });

    expect(messages[0]).toMatchObject({ content: 'null' });
  });

  it('returns an empty array for a tool turn with no toolResults', () => {
    expect(turnToWireMessages({ role: 'tool', toolResults: [] })).toEqual([]);
  });
});

describe('validateHistory, alternation', () => {
  it('does not throw for a valid alternating user/assistant history', () => {
    const history: ConversationTurn[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];

    expect(() => validateHistory(history)).not.toThrow();
  });

  it('does not throw for an empty history', () => {
    expect(() => validateHistory([])).not.toThrow();
  });

  it('throws on consecutive turns with the same role', () => {
    const history: ConversationTurn[] = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ];

    expect(() => validateHistory(history)).toThrow(
      expect.objectContaining({ type: 'invalid_params' }),
    );
  });

  it('throws when history ends on a user turn', () => {
    const history: ConversationTurn[] = [
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'hi again' },
    ];

    expect(() => validateHistory(history)).toThrow(
      expect.objectContaining({ type: 'invalid_params' }),
    );
  });
});

describe('validateHistory, tool turns', () => {
  it('does not throw when a tool turn follows an assistant tool request with matching results', () => {
    const history: ConversationTurn[] = [
      { role: 'user', content: 'weather?' },
      { role: 'assistant', toolCalls: [{ id: 'c1', name: 'weather', arguments: {} }] },
      { role: 'tool', toolResults: [{ toolCallId: 'c1', content: 'sunny' }] },
      { role: 'assistant', content: "it's sunny" },
    ];

    expect(() => validateHistory(history)).not.toThrow();
  });

  it('throws when a tool turn does not follow an assistant tool request', () => {
    const history: ConversationTurn[] = [
      { role: 'user', content: 'hi' },
      { role: 'tool', toolResults: [{ toolCallId: 'c1', content: 'x' }] },
    ];

    expect(() => validateHistory(history)).toThrow(
      expect.objectContaining({ type: 'invalid_params' }),
    );
  });

  it('throws when a tool turn has no toolResults', () => {
    const history: ConversationTurn[] = [
      { role: 'assistant', toolCalls: [{ id: 'c1', name: 'weather', arguments: {} }] },
      { role: 'tool', toolResults: [] },
    ];

    expect(() => validateHistory(history)).toThrow(
      expect.objectContaining({ type: 'invalid_params' }),
    );
  });

  it('throws for a toolResult referencing an unknown toolCallId', () => {
    const history: ConversationTurn[] = [
      { role: 'assistant', toolCalls: [{ id: 'c1', name: 'weather', arguments: {} }] },
      { role: 'tool', toolResults: [{ toolCallId: 'unknown', content: 'x' }] },
    ];

    try {
      validateHistory(history);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toMatchObject({
        type: 'invalid_params',
        code: 'unknown_tool_result_ids',
      });
    }
  });

  it('throws for duplicate toolCallIds among toolResults', () => {
    const history: ConversationTurn[] = [
      {
        role: 'assistant',
        toolCalls: [
          { id: 'c1', name: 'weather', arguments: {} },
          { id: 'c2', name: 'weather', arguments: {} },
        ],
      },
      {
        role: 'tool',
        toolResults: [
          { toolCallId: 'c1', content: 'x' },
          { toolCallId: 'c1', content: 'y' },
        ],
      },
    ];

    try {
      validateHistory(history);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toMatchObject({
        type: 'invalid_params',
        code: 'duplicate_tool_result_ids',
      });
    }
  });

  it('throws when a requested toolCallId has no matching result', () => {
    const history: ConversationTurn[] = [
      {
        role: 'assistant',
        toolCalls: [
          { id: 'c1', name: 'weather', arguments: {} },
          { id: 'c2', name: 'weather', arguments: {} },
        ],
      },
      { role: 'tool', toolResults: [{ toolCallId: 'c1', content: 'x' }] },
    ];

    try {
      validateHistory(history);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toMatchObject({
        type: 'invalid_params',
        code: 'missing_tool_results',
      });
    }
  });

  it('throws when history ends on an assistant tool request with no results', () => {
    const history: ConversationTurn[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', toolCalls: [{ id: 'c1', name: 'weather', arguments: {} }] },
    ];

    expect(() => validateHistory(history)).toThrow(
      expect.objectContaining({ type: 'invalid_params' }),
    );
  });

  it('does not throw for a plain assistant turn immediately after a tool turn', () => {
    const history: ConversationTurn[] = [
      { role: 'assistant', toolCalls: [{ id: 'c1', name: 'weather', arguments: {} }] },
      { role: 'tool', toolResults: [{ toolCallId: 'c1', content: 'sunny' }] },
      { role: 'assistant', content: 'done' },
    ];

    expect(() => validateHistory(history)).not.toThrow();
  });
});
