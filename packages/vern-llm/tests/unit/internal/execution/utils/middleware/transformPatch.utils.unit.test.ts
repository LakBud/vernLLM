import { describe, expect, it } from 'vitest';

import {
  assertModelAndResponseFormatUnchanged,
  assertNoDuplicateTools,
  mergePatch,
} from '../../../../../../src/internal/execution/utils/middleware/middleware.utils.js';
import { LLMError } from '../../../../../../src/types/errors.js';
import { baseRequest } from './middleware.helpers.js';

import type { WireCallRequest } from '../../../../../../src/types/middleware.js';

describe('mergePatch', () => {
  it('is a no-op for an empty patch', () => {
    const { request, patchedFields } = mergePatch(baseRequest, {});
    expect(request).toBe(baseRequest);
    expect(patchedFields).toEqual([]);
  });

  it('overwrites scalar fields', () => {
    const { request, patchedFields } = mergePatch(baseRequest, {
      temperature: 0.9,
      max_tokens: 50,
    });
    expect(request.temperature).toBe(0.9);
    expect(request.max_tokens).toBe(50);
    expect(patchedFields.sort()).toEqual(['max_tokens', 'temperature']);
  });

  it('overwrites reasoning_effort, budget_tokens, and tool_choice', () => {
    const { request, patchedFields } = mergePatch(baseRequest, {
      reasoning_effort: 'high',
      budget_tokens: 2048,
      tool_choice: 'auto',
    });
    expect(request.reasoning_effort).toBe('high');
    expect(request.budget_tokens).toBe(2048);
    expect(request.tool_choice).toBe('auto');
    expect(patchedFields.sort()).toEqual(['budget_tokens', 'reasoning_effort', 'tool_choice']);
  });

  it('appends addMessages without clobbering the original list', () => {
    const { request } = mergePatch(baseRequest, {
      addMessages: [{ role: 'user', content: 'appended' }],
    });
    expect(request.messages).toHaveLength(2);
    expect(request.messages[0]).toEqual(baseRequest.messages[0]);
    expect(request.messages[1]).toEqual({ role: 'user', content: 'appended' });
  });

  it('two sequential addMessages patches each append rather than overwrite the other', () => {
    const first = mergePatch(baseRequest, { addMessages: [{ role: 'user', content: 'first' }] });
    const second = mergePatch(first.request, {
      addMessages: [{ role: 'user', content: 'second' }],
    });
    expect(second.request.messages.map((m) => m.content)).toEqual(['hi', 'first', 'second']);
  });

  it('addTools appends across two independent patches without clobbering', () => {
    const first = mergePatch(baseRequest, {
      addTools: [
        { type: 'function', function: { name: 'toolA', description: 'a', parameters: {} } },
      ],
    });
    const second = mergePatch(first.request, {
      addTools: [
        { type: 'function', function: { name: 'toolB', description: 'b', parameters: {} } },
      ],
    });
    expect(second.request.tools?.map((t) => t.function.name)).toEqual(['toolA', 'toolB']);
  });

  it('a plain messages/tools replace still fully overwrites, as documented', () => {
    const { request } = mergePatch(baseRequest, {
      messages: [{ role: 'system', content: 'replaced' }],
    });
    expect(request.messages).toEqual([{ role: 'system', content: 'replaced' }]);
  });

  it('copies through a bypassed model/response_format field for the backstop guard to catch', () => {
    const patch = { model: 'sneaky' } as never;
    const { request, patchedFields } = mergePatch(baseRequest, patch);
    expect(request.model).toBe('sneaky');
    expect(patchedFields).toContain('model');
  });

  it('copies through a bypassed response_format field for the backstop guard to catch', () => {
    const patch = { response_format: { type: 'json_object' } } as never;
    const { request, patchedFields } = mergePatch(baseRequest, patch);
    expect(request.response_format).toEqual({ type: 'json_object' });
    expect(patchedFields).toContain('response_format');
  });

  it('a plain tools replace fully overwrites rather than appending', () => {
    const withTools: WireCallRequest = {
      ...baseRequest,
      tools: [{ type: 'function', function: { name: 'old', description: 'o', parameters: {} } }],
    };
    const { request } = mergePatch(withTools, {
      tools: [{ type: 'function', function: { name: 'new', description: 'n', parameters: {} } }],
    });
    expect(request.tools?.map((t) => t.function.name)).toEqual(['new']);
  });
});

describe('assertNoDuplicateTools', () => {
  it('does nothing when there are no tools', () => {
    expect(() => assertNoDuplicateTools(baseRequest, 'mw')).not.toThrow();
  });

  it('does nothing when tool names are unique', () => {
    const request: WireCallRequest = {
      ...baseRequest,
      tools: [
        { type: 'function', function: { name: 'a', description: '', parameters: {} } },
        { type: 'function', function: { name: 'b', description: '', parameters: {} } },
      ],
    };
    expect(() => assertNoDuplicateTools(request, 'mw')).not.toThrow();
  });

  it('throws invalid_params naming the offending middleware on a duplicate', () => {
    const request: WireCallRequest = {
      ...baseRequest,
      tools: [
        { type: 'function', function: { name: 'dup', description: '', parameters: {} } },
        { type: 'function', function: { name: 'dup', description: '', parameters: {} } },
      ],
    };
    try {
      assertNoDuplicateTools(request, 'tool-adder');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LLMError);
      expect((error as LLMError).type).toBe('invalid_params');
      expect((error as LLMError).message).toContain('tool-adder');
      expect((error as LLMError).message).toContain('dup');
    }
  });
});

describe('assertModelAndResponseFormatUnchanged', () => {
  it('does nothing when neither field changed', () => {
    expect(() =>
      assertModelAndResponseFormatUnchanged(baseRequest, { ...baseRequest }, 'mw'),
    ).not.toThrow();
  });

  it('throws invalid_params when model changed', () => {
    expect(() =>
      assertModelAndResponseFormatUnchanged(baseRequest, { ...baseRequest, model: 'other' }, 'mw'),
    ).toThrow(/changed `model`/);
  });

  it('throws invalid_params when response_format changed', () => {
    expect(() =>
      assertModelAndResponseFormatUnchanged(
        baseRequest,
        { ...baseRequest, response_format: { type: 'json_object' } },
        'mw',
      ),
    ).toThrow(/changed `response_format`/);
  });
});
