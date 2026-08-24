-- Read back the tty and tab title of an iTerm2 session, addressed by its id or its tty.
--
-- The read half of what lib/reap.js needs before it will close a never-started window
-- (bc-xl7n.113.3): before the close, it has to reconfirm the two things the bead's own
-- hazard paragraph names — that the tab still carries this bead's id, and, via `ps` on
-- the tty this prints, that no `claude` process has since started there. Only the second
-- of those can be asked from Node at all, which is why this stops at reading and leaves
-- both checks to the caller.
--
-- Same handle as message-session.applescript and focus-session.applescript: an iTerm
-- session id, or a `/dev/ttysNNN` path. See their headers for why the two cannot collide.
--
-- Prints two lines — the tty, then the tab title, in that order — or the literal
-- `missing` when no session carries the handle any more, which is the answer "that
-- window is already gone" and the only honest way to learn it.
--
-- Never launches iTerm: with iTerm not running there is nothing to describe, and asking
-- would start a terminal in order to report that there is nothing in it.

on run argv
	set wantedId to item 1 of argv
	if not (application id "com.googlecode.iterm2" is running) then return "missing"

	tell application id "com.googlecode.iterm2"
		repeat with w in windows
			repeat with t in tabs of w
				repeat with s in sessions of t
					if ((id of s) as text) is equal to wantedId or (tty of s) is equal to wantedId then
						return (tty of s) & linefeed & (name of s)
					end if
				end repeat
			end repeat
		end repeat
	end tell
	return "missing"
end run
