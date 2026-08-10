-- Say something to an iTerm2 session that is already open, addressed by its id.
--
-- The advocate's workers are iTerm windows, not processes the daemon owns, so there
-- is no socket and no stdin to write to: `write text` into the session is the whole
-- channel back into one. It puts the words in the TUI and presses return, exactly as
-- if they had been typed there. Claude Code accepts input while a turn is running and
-- answers it when the turn lands, so this does not need the session to be idle.
--
-- **The text must be one line.** `write text` ends with a return, so a second line
-- would submit as a second message — half a sentence into a running agent. Node
-- flattens it before it gets here; see `messageSession` in lib/session.js.
--
-- Prints `sent`, or `missing` when no session carries that id. Missing is not an
-- error: it is the answer to "is that window still there", and the only honest way
-- to learn it, since closing a window tells the daemon nothing.
--
-- No `activate`. Asking a session whether it is still working must not pull the
-- machine's focus away from whatever you are doing in front of it.

on run argv
	set wantedId to item 1 of argv
	set theText to item 2 of argv

	tell application id "com.googlecode.iterm2"
		repeat with w in windows
			repeat with t in tabs of w
				repeat with s in sessions of t
					if ((id of s) as text) is equal to wantedId then
						tell s to write text theText
						return "sent"
					end if
				end repeat
			end repeat
		end repeat
	end tell
	return "missing"
end run
