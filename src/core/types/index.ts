// Public barrel for the scene schema. Consumers import `core/types`;
// the schema is split by part family across this directory (see base.ts for the shared
// leaf, <family>.ts for each part group's params + defs, parts.ts for the assembly).
export * from './base'
export * from './structure'
export * from './parts'
