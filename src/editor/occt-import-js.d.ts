// occt-import-js ships no types. Its default export is the emscripten module factory; what the resolved module
// can do is typed where it is used (stepConvert.ts OcctKernel), not guessed here.
declare module 'occt-import-js' {
  const occtimportjs: (moduleArg?: { locateFile?: (file: string) => string }) => Promise<unknown>
  export default occtimportjs
}
