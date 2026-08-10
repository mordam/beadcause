-- Every terminal iTerm2 is currently hosting, one `/dev/ttysNNN` per line.
--
-- This is the "can I speak to it" half of talking to a live session. A pid gives you a
-- controlling tty (`ps -o tty=`); this says whether that tty is a window on this Mac or
-- something else entirely — Terminal.app, tmux, a VS Code panel, an ssh login. A
-- session in any of those is running perfectly well and cannot be typed into from the
-- phone, and the page has to be able to say so *before* you type rather than after.
--
-- Two properties it must hold, both because `/api/session-log` polls every two
-- seconds:
--
--   - **It never launches iTerm.** `is running` on an application specifier is a
--     question, not a use — it does not start the app — and asking would otherwise open
--     a terminal on the Mac every time a phone opened this page. Nothing when it is
--     not running, which reads correctly: no windows, so no session is reachable.
--   - **It is cheap enough to poll.** ~130ms with a dozen windows open, and the caller
--     caches it for a few seconds on top of that; see `itermTtys` in lib/session.js.
--
-- Newline-separated rather than AppleScript's `{a, b}` list syntax, so the caller
-- splits on a character that cannot appear in a device path.

on run
	if not (application id "com.googlecode.iterm2" is running) then return ""

	set found to {}
	tell application id "com.googlecode.iterm2"
		repeat with w in windows
			repeat with t in tabs of w
				repeat with s in sessions of t
					set end of found to (tty of s)
				end repeat
			end repeat
		end repeat
	end tell

	set text item delimiters to linefeed
	return found as text
end run
