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
-- **The text must be one line.** `write text` ends with a return, so a second line
-- would submit as a second message — half a sentence into a running agent. Node
-- flattens it before it gets here; see `messageSession` in lib/session.js.
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

	-- Never launch iTerm to deliver a message. A daemon that opened the terminal in
	-- order to find out nobody was there has already made the answer wrong.
	if not (application id "com.googlecode.iterm2" is running) then return "missing"

	tell application id "com.googlecode.iterm2"
		repeat with w in windows
			repeat with t in tabs of w
				repeat with s in sessions of t
					if ((id of s) as text) is equal to wantedId or (tty of s) is equal to wantedId then
						tell s to write text theText
						return "sent"
					end if
				end repeat
			end repeat
		end repeat
	end tell
	return "missing"
end run
