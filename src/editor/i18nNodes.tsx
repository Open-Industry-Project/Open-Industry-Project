import { Fragment, type ReactNode } from 'react'
import { tParts, type MessageId } from '../core/i18n'

/**
 * `tParts` for JSX: a translated sentence with elements inside it (`{key}` → `<kbd>G</kbd>`), keyed so React
 * can render the pieces as a list. Use it instead of splitting a sentence around an element, which hands a
 * translator fragments without their word order.
 */
export function tNodes(id: MessageId, params: Readonly<Record<string, ReactNode>>): ReactNode {
  return tParts(id, params).map((piece, i) => <Fragment key={i}>{piece}</Fragment>)
}
