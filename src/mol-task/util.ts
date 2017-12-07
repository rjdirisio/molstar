
// enum TaskState {
//     Pending,
//     Running,
//     Aborted,
//     Completed,
//     Failed
// }

interface TaskState {

}

namespace TaskState {
    export interface Pending { kind: 'Pending' }
    export interface Running { kind: 'Running',  }

    export interface Progress {
        message: string,
        isIndeterminate: boolean,
        current: number,
        max: number,
        elapsedMs: number
    }
}

type ExecutionContext = {
    run<T>(c: Computation<T>, params?: { updateRateMs: number }): Promise<T>,
    subscribe(o: (p: string, compId: number) => void): void,

    requestAbort(compId: number): void
}

namespace ExecutionContext {
    // export interface Synchronous extends ExecutionContext {
    //     run<T>(c: Computation<T>, params?: { updateRateMs: number }): Promise<T>,
    // }

    // export interface Observable extends ExecutionContext {
    //     run<T>(c: Computation<T>, params?: { updateRateMs: number }): Promise<T>,
    // }
    export const Sync: ExecutionContext = 0 as any;
}

interface RuntimeContext {
    run<T>(c: Computation<T>, params?: { updateRateMs: number }): Promise<T>,
    yield(name: string): Promise<void> | void
}

// if no context is specified, use the synchronous one.
interface Computation<T> { (ctx: RuntimeContext): Promise<T>, _id: number }

function create<T>(c: (ctx: RuntimeContext) => Promise<T>): Computation<T> { return 0 as any; }
function constant<T>(c: T) { return create(async ctx => c); }

type MultistepFn<P, T> = (params: P, step: (s: number) => Promise<void> | void, ctx: RuntimeContext) => Promise<T>
type ComputationProvider<P, T> = (params: P) => Computation<T>
function MultistepComputation<P, T>(name: string, steps: string[], f: MultistepFn<P, T>): ComputationProvider<P, T> {
    return params => create(async ctx => f(params, n => ctx.yield(steps[n]), ctx));
}


// if total count is specified, could automatically provide percentage
type UniformlyChunkedFn<S> = (chunkSize: number, state: S, totalCount?: number) => number
type UniformlyChunkedProvider<S> = (ctx: RuntimeContext, state: S) => Promise<S>
function UniformlyChunked<S>(label: string, initialChunk: number, f: UniformlyChunkedFn<S>): UniformlyChunkedProvider<S> {
    // TODO: track average time required for single element and then determine chunk size based on that.
    return 0 as any;
}

type LineReaderState = { str: string, position: number, lines: string[] }
const uniformPart = UniformlyChunked('Reading lines', 1000000, (size, state: LineReaderState) => {
    state.position += size;
    state.lines.push('');
    return 0 /* number of lines read */;
});

function readLines(str: string): Computation<string[]> {
    return create(async ctx => {
        const state = (await uniformPart(ctx, { str, position: 0, lines: [] }));
        return state.lines;
    });
}

const prependHiToLines = MultistepComputation('Hi prepend', ['Parse input', 'Prepend Hi'], async (p: string, step, ctx) => {
    await step(0);
    const lines = await readLines(p)(ctx);
    await step(1);
    const ret = lines.map(l => 'Hi ' + l);
    return ret;
});


(async function() {
    const r = await ExecutionContext.Sync.run(prependHiToLines('1\n2'), { updateRateMs: 150 });
    console.log(r)
}())
