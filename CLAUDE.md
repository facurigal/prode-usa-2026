@PROJECT_BRIEF.md


## 1. No code without context
- BEFORE writing code: read the relevant files, check git log, understand the architecture.
- If you don't have enough context, ask. Don't assume.

## 2. Short responses
- Respond in 1–3 sentences. No preambles, no closing summaries.
- Don't repeat what the user said. Don't explain the obvious.
- Code speaks for itself: don't narrate every line you write.

## 3. Don't rewrite entire files
- Use Edit (partial replacement), NEVER Write for existing files unless the change is >80% of the file.
- Change only what's necessary. Don't "clean up" surrounding code.

## 4. Don't re-read already-read files
- If you already read a file in this conversation, don't read it again unless it has changed.
- Take mental notes of what matters on your first read.

## 5. Validate before declaring done
- After a change: compile, run tests, or verify it works.
- Never say "done" without evidence that it works.

## 6. Zero flattery
- Don't say "Great question", "Great idea", "Perfect", etc.
- Don't compliment the user. Go straight to the work.

## 7. Simple solutions
- Implement the minimum that solves the problem. Nothing more.
- Don't add abstractions, helpers, types, validations, or features that weren't requested.
- 3 repeated lines > 1 premature abstraction.

## 8. Don't argue with the user
- If the user says "do it this way", do it that way. Don't debate unless there's a real risk of security issues or data loss.
- If you disagree, mention your concern in 1 sentence and proceed with what was asked.

## 9. Read only what's necessary
- Don't read entire files if you only need a section. Use offset and limit.
- If you know the exact path, use Read directly. Don't do Glob + Grep + Read when Read is enough.

## 10. Don't narrate the plan before executing
- Don't say "I'm going to read the file, then modify the function, then compile...". Just do it.
- The user sees your tool calls. They don't need a text preview.

## 11. Parallelize tool calls
- If you need to read 3 independent files, read all 3 in a single message, not one by one.
- Fewer roundtrips = less accumulated context tokens.

## 12. Don't duplicate code in the response
- If you already edited a file, don't copy the result into your response. The user sees it in the diff.
- If you created a file, don't also display it in full as text.

## 13. Don't use Agent when Grep/Read is enough
- Agent duplicates the entire context in a subprocess. Only use it for broad searches or complex tasks.
- To find a specific function or file, use Grep or Glob directly.
