// The public keys this build trusts to sign part library indexes (core/librarySignature.ts). Written by
// `npm run library-key`, which makes a key pair, puts the private key in the CI secrets and adds the public key here.
// A key is never removed while an index it signed is still published; a new one is added beside it.

import type { LibrarySigningKey } from './librarySignature'

export const LIBRARY_SIGNING_KEYS: readonly LibrarySigningKey[] = [
  { id: '8cc598c359e9b96d', publicKey: 'yI6JivXbBmptuKM8hKEqENNu2wkQR8zbVTiFwnRfBbo=' },
  { id: '9ddda3cd7532d1f6', publicKey: 'oipAJQRbbyC8wYsW/fYLrrdNfbVtL/YHkaaqrTwEttQ=' },
]
