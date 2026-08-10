-- Say something to an iTerm2 session that is already open, addressed by its id or its tty.
--
-- The advocate's workers are iTerm windows, not processes the daemon owns, so there
-- is no socket and no stdin to write to: `write text` into the session is the whole
-- channel back into one. It puts the words in the TUI and presses return, exactly as
-- if they had been typed there. Claude Code accepts input while a turn is running and
-- answers it when the turn lands, so this does not need the session to be idle.
--
-- **Two kinds of handle, because there are two kinds of session.** The advocate keeps
-- the iTerm session id of every worker it opened, and that is the exact handle. But a
-- session started at the keyboard was never opened by this daemon and has no such id
-- anywhere — and those are most of them. What every session does have is a controlling
-- terminal, so a handle of the form `/dev/ttysNNN` is matched against `tty of s`
-- instead: `ps -o tty=` turns a pid into one, which makes any Claude Code session on
-- the Mac addressable by the only thing that identifies a process. See
-- `resolveSessionHandle` in lib/session.js.
--
-- The two cannot collide — an iTerm session id is a UUID and a tty path starts with a
-- slash — so one comparison against either is safe, and the caller does not have to
-- say which kind it is holding.
--
-- **Multi-line text, in two statements.** `write text` adds a return by default, so a
-- message with a second line in it used to submit as two messages — half a sentence
-- into a running agent — and Node flattened it to one line before it got here. It does
-- not any more. `write` takes a `newline` boolean (iTerm2.sdef, code `Wtnl`), so
-- `newline no` puts bytes on the pty and stops: the paste goes down first and submits
-- nothing, then a bare `write text ""` is the single Return that sends it as one turn.
-- Proven end to end in docs/ide-websocket-spike.md, which is where the second channel
-- this replaced was declined.
--
-- The payload is wrapped in bracketed paste (`ESC[200~` … `ESC[201~`) and the markers
-- are built here rather than passed in, so the one part of the message that must be
-- exactly right cannot be mangled on its way through argv. Claude Code honours them and
-- keeps every line, blank line and indent; without them the send would rest on the TUI
-- happening to submit on CR and not LF, which is true today and is not a promise.
--
-- Order is safe without a delay: both writes go to the same pty, bytes arrive in the
-- order they were written, and the paste is self-terminating — the Return cannot
-- overtake it or be swallowed by it.
--
-- One thing worth knowing about what you will see on the Mac: over a few lines the
-- composer shows `[Pasted text #1 +6 lines]` rather than the words. The full message is
-- there and submits in full, but anything reading the composer back is reading a
-- placeholder, not the message.
--
-- Prints `sent`, or `missing` when no session carries that handle. Missing is not an
-- error: it is the answer to "is that window still there", and the only honest way
-- to learn it, since closing a window tells the daemon nothing.
--
-- No `activate`. Asking a session whether it is still working must not pull the
-- machine's focus away from whatever you are doing in front of it.

on run argv
	set wantedId to item 1 of argv
	set theText to item 2 of argv
	set esc to (ASCII character 27)
	set pasted to esc & "[200~" & theText & esc & "[201~"

	-- Never launch iTerm to deliver a message. A daemon that opened the terminal in
	-- order to find out nobody was there has already made the answer wrong.
	if not (application id "com.googlecode.iterm2" is running) then return "missing"

	tell application id "com.googlecode.iterm2"
		repeat with w in windows
			repeat with t in tabs of w
				repeat with s in sessions of t
					if ((id of s) as text) is equal to wantedId or (tty of s) is equal to wantedId then
						-- The message, then the Return that sends it. Two statements, one turn.
						tell s to write text pasted newline no
						tell s to write text ""
						return "sent"
					end if
				end repeat
			end repeat
		end repeat
	end tell
	return "missing"
end run
