/** Composition of every use-case over one `Dependencies` graph. (Types in
 * `use-cases-core-a.ts` / `use-cases-core-b.ts` / `use-cases-extra.ts`, build in `use-cases-build.ts`.) */

export type { UseCases } from "./use-cases-build.ts"
export { buildUseCases } from "./use-cases-build.ts"
export type { AuthStatusRequest, UseCasesCoreA } from "./use-cases-core-a.ts"
export type { UseCasesCoreB } from "./use-cases-core-b.ts"
export type { UseCasesExtra } from "./use-cases-extra.ts"
