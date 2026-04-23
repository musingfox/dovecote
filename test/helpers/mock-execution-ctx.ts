export interface MockExecutionContext {
  props: any;
  waitUntil: (promise: Promise<any>) => void;
  passThroughOnException: () => void;
  _promises: Promise<any>[];
}

export function createMockExecutionCtx(props: any = null): MockExecutionContext {
  const promises: Promise<any>[] = [];

  return {
    props,
    waitUntil: (promise: Promise<any>) => {
      promises.push(promise);
    },
    passThroughOnException: () => {},
    _promises: promises,
  };
}
