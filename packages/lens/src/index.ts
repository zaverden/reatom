import {
  action,
  Action,
  ActionIs,
  ActionResult,
  atom,
  Atom,
  AtomCache,
  AtomMut,
  AtomState,
  Ctx,
  CtxLessParams,
  Fn,
  throwReatomError,
} from '@reatom/core'
import { onUpdate } from '@reatom/hooks'
import { Plain, assign } from '@reatom/utils'

declare const NEVER: unique symbol
type NEVER = typeof NEVER

// This type only need to omit empty `{}` for an atom without extra properties
export type AtomMap<
  T extends Atom,
  State = AtomState<T>,
  Args extends any[] = CtxLessParams<T, NEVER[]>,
> = AtomProperties<T> extends never
  ? AtomMapCallable<T, State, Args>
  : AtomMapCallable<T, State, Args> & {
      [K in AtomProperties<T>]: T[K]
    }

type AtomProperties<T> = keyof Omit<T, '__reatom' | 'pipe'>

type AtomMapCallable<
  T extends Atom,
  State = AtomState<T>,
  Args extends any[] = CtxLessParams<T, NEVER[]>,
> = ActionIs<T> extends true
  ? Action<Args, State>
  : T extends AtomMut<AtomState<T>, any>
  ? AtomMut<State, Args>
  : Atom<State>

const getAtomBlank = (
  parentAtom: Atom | AtomMut | Action,
  derivedAtom?: Atom,
): {} =>
  derivedAtom && typeof parentAtom === 'function'
    ? (ctx: Ctx, ...a: any[]) =>
        // @ts-ignore
        ctx.get(() => (parentAtom(ctx, ...a), ctx.get(derivedAtom)))
    : {}

/** Remove callable signature to prevent the atom update from outside (with all properties saving)  */
export const readonly = <T extends Atom>(
  anAtom: T,
): AtomMap<T, AtomState<T>, NEVER[]> => Object.assign<any, any>({}, anAtom)

/** Remove all extra properties from the atom to pick the essence (with callable signature saving) */
export const plain = <T extends Atom>(anAtom: T): AtomMapCallable<T> =>
  Object.assign(getAtomBlank(anAtom) as any, {
    __reatom: anAtom.__reatom,
    pipe: anAtom.pipe,
  })

/** Transform atom state (with all properties and callable signature saving) */
export const mapState =
  <T extends Atom, Res>(
    mapper: Fn<[Ctx, AtomState<T>, undefined | AtomState<T>], Res>,
    name?: string,
  ): Fn<[T], AtomMap<T, Res>> =>
  (anAtom: Atom): any => {
    const { isAction } = anAtom.__reatom
    const theAtom = atom(
      (ctx) => mapper(ctx, ctx.spy(anAtom), ctx.cause!.parents.at(0)?.state),
      name,
    )
    theAtom.__reatom.isAction = isAction

    return Object.assign(getAtomBlank(anAtom, theAtom), anAtom, theAtom)
  }

/** Get atom (with all properties saving) with resolved action value in state */
export const mapAsync =
  <T extends Atom, Res>(
    mapper: Fn<
      [Ctx, Awaited<ActionIs<T> extends true ? ActionResult<T> : AtomState<T>>],
      Res
    >,
    name?: string,
  ): Fn<
    [T],
    AtomMap<T, Awaited<Res> | (ActionIs<T> extends true ? never : undefined)>
  > =>
  (anAction): any => {
    const { isAction } = anAction.__reatom
    const versionAtom = atom(0)
    const theAtom = atom((ctx, state?: any) => {
      let value: any = ctx.spy(anAction as Atom)
      if (isAction) {
        state ??= []
        if (value.length === 0) return state
        value = value.at(-1)
      }

      if (value instanceof Promise) {
        const version = versionAtom(ctx, (s) => ++s)

        value.then(
          (v) =>
            version === ctx.get(versionAtom) &&
            ctx.get((read, actualize) =>
              actualize!(
                ctx,
                ctx.cause!.meta,
                (patchCtx: Ctx, patch: AtomCache) => {
                  patch.cause = ctx.cause!.cause
                  const value = mapper(ctx, v)
                  patch.state = isAction ? [value] : value
                },
              ),
            ),
          () => {},
        )

        return state
      }

      return mapper(ctx, value)
    }, name)
    theAtom.__reatom.isAction = isAction

    return Object.assign(getAtomBlank(anAction, theAtom), anAction, theAtom)
  }

/** Transform atom update payload (with all properties saving) */
// TODO type inference broken on without explicit Ctx return (currently described by `Parameters<T>`)
export const mapInput =
  <T extends AtomMut | Action, Args extends [Ctx, ...any[]]>(
    mapper: Fn<Args, Parameters<T>>,
  ): Fn<[T], AtomMap<T, AtomState<T>, CtxLessParams<Args>>> =>
  (anAtom): any =>
    Object.assign(
      // @ts-ignore
      (ctx: Ctx, ...args: Args) => anAtom(...mapper(ctx, ...args)),
      anAtom,
    )

/** Filter atom updates (with all properties saving) */
export const filter = <T extends Atom>(
  predicate: T extends Action<any, T>
    ? Fn<[T, T], boolean>
    : Fn<[AtomState<T>, AtomState<T>], boolean>,
  name?: string,
): Fn<[T], T> =>
  // @ts-ignore
  mapState(
    (ctx, newState, oldState) =>
      ctx.cause!.parents.length === 0
        ? newState
        : predicate(newState, oldState!)
        ? newState
        : oldState!,
    name,
  )

/** Convert action to atom with optional fallback state */
export const toAtom =
  <T extends Action, State = undefined | ActionResult<T>>(
    fallback?: State,
    mapper: Fn<[Ctx, ActionResult<T>], State> = (ctx, v: any) => v,
    name?: string,
  ): Fn<
    [T],
    AtomProperties<T> extends never
      ? AtomMut<State | ActionResult<T>, CtxLessParams<T>>
      : AtomMut<State | ActionResult<T>, CtxLessParams<T>> & {
          [K in AtomProperties<T>]: T[K]
        }
  > =>
  (anAction): any => {
    throwReatomError(
      !anAction.__reatom.isAction,
      'received atom instead of action',
    )

    const theAtom = atom(
      (ctx, state = fallback) =>
        ctx.spy(anAction).reduce((acc, v) => mapper(ctx, v /* , acc */), state),
      name,
    )

    return Object.assign(getAtomBlank(anAction, theAtom), anAction, theAtom)
  }

/** The action will react to new atom updates */
export const toAction =
  <T>(name?: string): Fn<[Atom<T>], Action<[never], T>> =>
  (anAtom) => {
    const theAction = atom((ctx, state?: any[]) => {
      const value = ctx.spy(anAtom)

      // skip first computation by connection
      if (state === undefined) {
        return []
      }

      return state.concat([value])
    }, name)
    theAction.__reatom.isAction = true
    return theAction as Action
  }

export const toPromise =
  <T, Res = T>(
    ctx: Ctx,
    mapper: Fn<[Ctx, T], Res> = (ctx, v: any) => v,
  ): Fn<[Atom<T>], Promise<Res>> =>
  (anAtom) =>
    new Promise((res, rej) => {
      const un = onUpdate(anAtom, (_ctx, state) => {
        if (ctx !== _ctx) return

        // multiple updates will be ignored
        // and only first will accepted
        ctx.schedule(() =>
          new Promise(
            () => (
              un(),
              res(
                mapper(
                  ctx,
                  // @ts-ignore
                  state,
                ),
              )
            ),
          ).catch(rej),
        )
      })
    })

// TODO
// export const view = <T, K extends keyof T>
