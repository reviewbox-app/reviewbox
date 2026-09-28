export type PseudoTokenKind =
  | "plain"
  | "comment"
  | "string"
  | "number"
  | "boolean"
  | "keyword.control"
  | "keyword.action"
  | "operator"
  | "punctuation"
  | "function"
  | "parameter"
  | "type"
  | "property"
  | "variable"
  | "constant"

export interface PseudoToken {
  text: string
  start: number
  kind: PseudoTokenKind
}

export interface PseudoState {
  blockComment: boolean
}

const control =
  /^(?:ELSE\s+IF|FOR\s+EACH|AS\s+LONG\s+AS|IS\s+NOT|IS\s+EMPTY|IS\s+PRESENT|NOT\s+FOUND|END\s+(?:IF|FOR|WHILE|FUNCTION|TRY)|IF|THEN|ELSE|UNLESS|END|FOR|EACH|IN|OF|WHILE|UNTIL|REPEAT|DO|WHEN|CASE|MATCH|SWITCH|DEFAULT|RETURN|YIELD|BREAK|CONTINUE|TRY|CATCH|FINALLY|THROW|RAISE|ON|AWAIT|ASYNC|PARALLEL|SI|ALORS|SINON|FIN|POUR|CHAQUE|TANT\s+QUE|RETOURNER)\b/i
const actions =
  /^(?:FUNCTION|PROCEDURE|METHOD|CLASS|TYPE|INTERFACE|ENUM|SET|LET|CONST|GET|CREATE|READ|WRITE|DELETE|CALL|UPDATE|APPEND|REMOVE|INSERT|FIND|FILTER|MAP|REDUCE|SORT|LOAD|SAVE|FETCH|SEND|EMIT|WAIT|RESOLVE|REJECT|RENDER|SHOW|HIDE|DISPLAY|INITIALIZE|VALIDATE|ENSURE|LIRE|ÉCRIRE|CRÉER)\b/i
const operators =
  /^(?:AND|OR|NOT|IS|EQUALS|CONTAINS|EXISTS|TO|FROM|WITH|WITHOUT|AS)\b|^(?:===?|!==?|<=?|>=?|=>|->|←|→|\?\?|&&|\|\||[+*/%!?-])/i
const identifier = /^[$\p{L}_][$\p{L}\p{N}_]*/u

function hasStructure(line: string, state: PseudoState) {
  let text = line.trimStart()
  if (state.blockComment) {
    const end = text.indexOf("*/")
    text = end < 0 ? "" : text.slice(end + 2).trimStart()
  }
  while (text.startsWith("/*") && text.includes("*/"))
    text = text.slice(text.indexOf("*/") + 2).trimStart()
  return (
    control.test(text) ||
    actions.test(text) ||
    /^[$\p{L}_][$\p{L}\p{N}_.]*(?:\s*\([^)]*\))?\s*(?:[(:=]|[+*\/%-]=|\b(?:IS|CONTAINS|EXISTS)\b)/iu.test(
      text
    )
  )
}

/** Tolerant display lexer: recognized structure is colored, prose stays prose. */
export function tokenizePseudoLine(
  line: string,
  previous: PseudoState = { blockComment: false }
) {
  const state = { ...previous }
  const structured = hasStructure(line, previous)
  const tokens: PseudoToken[] = []
  let cursor = 0
  let declaration: "function" | "type" | "variable" | null = null
  let parameters = false
  let afterDot = false
  let previousWord = ""
  const push = (text: string, kind: PseudoTokenKind) => {
    tokens.push({ text, start: cursor, kind })
    cursor += text.length
  }
  while (cursor < line.length) {
    const rest = line.slice(cursor)
    if (state.blockComment || rest.startsWith("/*")) {
      const end = line.indexOf("*/", cursor + (state.blockComment ? 0 : 2))
      push(line.slice(cursor, end < 0 ? line.length : end + 2), "comment")
      state.blockComment = end < 0
      continue
    }
    if (/^(?:#|\/\/)/.test(rest)) {
      push(rest, "comment")
      break
    }
    const space = /^\s+/.exec(rest)?.[0]
    if (space) {
      push(space, "plain")
      continue
    }
    if (/^["'`]/.test(rest)) {
      const quote = rest[0]
      let end = 1
      while (end < rest.length) {
        if (rest[end] === "\\") {
          end += 2
          continue
        }
        if (rest[end++] === quote) break
      }
      push(rest.slice(0, end), "string")
      continue
    }
    const number = /^(?:-?(?:0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?))\b/i.exec(
      rest
    )?.[0]
    if (number) {
      push(number, structured ? "number" : "plain")
      continue
    }
    const literal = /^(?:TRUE|FALSE|NULL|NIL|NONE|UNDEFINED|VRAI|FAUX)\b/i.exec(
      rest
    )?.[0]
    if (literal && structured && !afterDot && !declaration) {
      push(literal, "boolean")
      continue
    }
    const keyword = control.exec(rest)?.[0]
    if (keyword && structured && !afterDot && !declaration) {
      push(keyword, "keyword.control")
      previousWord = keyword.toUpperCase()
      continue
    }
    const action = actions.exec(rest)?.[0]
    if (action && structured && !afterDot && !declaration) {
      push(action, "keyword.action")
      previousWord = action.toUpperCase()
      declaration = /^(FUNCTION|PROCEDURE|METHOD)$/.test(previousWord)
        ? "function"
        : /^(CLASS|TYPE|INTERFACE|ENUM)$/.test(previousWord)
          ? "type"
          : /^(SET|LET|CONST)$/.test(previousWord)
            ? "variable"
            : null
      continue
    }
    const operator = operators.exec(rest)?.[0]
    if (operator && structured && !afterDot && !declaration) {
      push(operator, "operator")
      continue
    }
    const word = identifier.exec(rest)?.[0]
    if (word) {
      const next = rest.slice(word.length)
      const kind: PseudoTokenKind = !structured
        ? "plain"
        : (declaration ??
          (/^\s*\(/.test(next) || previousWord === "CALL"
            ? "function"
            : afterDot
              ? "property"
              : parameters
                ? "parameter"
                : /^[A-Z][A-Z\d_]+$/.test(word)
                  ? "constant"
                  : /^[A-Z][a-z]/.test(word)
                    ? "type"
                    : /[_$]|[a-z][A-Z]|\d/.test(word) ||
                        /^\s*(?::|=(?!=))/.test(next)
                      ? "variable"
                      : "plain"))
      if (declaration === "function") parameters = true
      push(word, kind)
      declaration = null
      afterDot = false
      previousWord = word
      continue
    }
    const character = rest[0]
    if (character === ")") parameters = false
    afterDot = character === "."
    push(
      character,
      structured && /[()[\]{},.:;]/.test(character) ? "punctuation" : "plain"
    )
  }
  return { tokens, state }
}

export function tokenizePseudocode(text: string) {
  let state: PseudoState = { blockComment: false }
  return text.split("\n").map((line) => {
    const result = tokenizePseudoLine(line, state)
    state = result.state
    return result.tokens
  })
}
