// The dialect a scene's PLC program is written in: a forward-compatibility marker, nothing more.
//
// This build reads one language family, IEC 61131-3 (its Structured Text and the ladder that lowers onto it). A
// program written for any other family is text in the same `stProgram` field, and a build that read it as IEC would
// compile it into nonsense errors, run whatever happened to parse, and rewrite it on the next edit. So a document may
// say which family its program is in, and a build that does not have that family refuses the program instead of
// misreading it.
//
// The rules: an absent field means IEC. Every document written before the field existed is IEC, and the field is
// never written for IEC, so none of those documents, folders or rooms change a byte. Any other string is a dialect
// this build does not have: it is kept exactly as written through every load and save, the rest of the document loads,
// and the program is refused at run time with {@link dialectRefusal}, never read. Only a value that is not a string
// at all is a malformed document ({@link validateDialect}).
//
// Travels beside the program in the project document, the folder manifest, the scene file and a collab room
// (`meta.stDialect`).

/** Can this build run a program in dialect `d`? Only IEC, which is what an absent field (or an explicit "iec") is. */
export function isKnownDialect(d: string | undefined): d is 'iec' | undefined {
  return d === undefined || d === 'iec'
}

/**
 * The form a dialect is kept in: undefined for IEC (absent, however it arrived: `'iec'`, undefined or null), the
 * string itself for anything else. Every writer goes through this, which is what keeps an IEC document from ever
 * gaining the field.
 */
export function storedDialect(d: string | null | undefined): string | undefined {
  return d === null || d === undefined || d === 'iec' ? undefined : d
}

/** Why a program in dialect `d` does not run here. One message for the editor, the Problems dock and the CLIs. */
export function dialectRefusal(d: string): string {
  return `This program is written for the '${d}' dialect, which this version of the app cannot run. It is kept unchanged - open it in a version that has that dialect.`
}

/** The same refusal in a few words, for the tooltip of a control it disables (the PLC panel's, for one). */
export function foreignDialectNote(d: string): string {
  return `Written for the '${d}' dialect, which this version cannot edit or run`
}

/**
 * Structural validation of a document's `stDialect`. A non-empty string of any spelling is valid, including one this
 * build does not have (it is kept and refused at run time, not rejected at load). Anything else, a
 * number or an empty string, is a malformed document, refused with where it sits. Returns the kept form.
 */
export function validateDialect(raw: unknown, at = 'stDialect'): { ok: true; dialect: string | undefined } | { ok: false; errors: string[] } {
  if (raw === undefined) return { ok: true, dialect: undefined }
  if (typeof raw !== 'string' || raw === '') {
    return { ok: false, errors: [`${at} must name the program's dialect as a string ("iec", or left out for IEC)`] }
  }
  return { ok: true, dialect: storedDialect(raw) }
}
