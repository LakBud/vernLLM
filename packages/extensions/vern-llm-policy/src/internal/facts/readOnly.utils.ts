const views = new WeakMap<object, object>();

function refuse(): never {
  throw new TypeError('a policy function must not change the facts of a call');
}

/**
 * A read only view of `context` for `when` functions, so one cannot change what later rules see.
 * Only plain objects and arrays are wrapped.
 */
export function readOnly<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return value;

  let view = views.get(value);
  if (view === undefined) {
    view = new Proxy(value, {
      get(target, key) {
        const found: unknown = Reflect.get(target, key);
        const own = Reflect.getOwnPropertyDescriptor(target, key);
        // A frozen property must be reported as it is.
        if (own !== undefined && !own.configurable && own.writable === false) return found;
        return readOnly(found);
      },
      set: refuse,
      defineProperty: refuse,
      deleteProperty: refuse,
      setPrototypeOf: refuse,
    });
    views.set(value, view);
  }
  return view as T;
}
