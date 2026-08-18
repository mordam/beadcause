-- Close the iTerm2 windows that have no tabs left in them.
--
-- A window with no tabs is a window with no session: nothing to read, nothing running,
-- and no way back into it. It is not a state anything asks for — it is what iTerm
-- occasionally leaves behind when the last session in a window ends. Two were caught on
-- 18 Aug by sampling iTerm every twenty seconds: the `bc-y8k4.4` worker went from a live
-- session on /dev/ttys018 to `tabs=0` inside one sample, and the `viewbar-check` worker
-- did the same two hours later. Both had been signalled by lib/reap.js in the ordinary
-- way, and both were left named `sleep` — the last job of `SENDOFF` in lib/session.js —
-- so the shell got all the way through its send-off and ran `exit`. The session teardown
-- was right; iTerm closed the tab and did not close the window behind it.
--
-- Nothing else in beadcause closes a window. The only close is the shell's own `exit`,
-- so a frame that has already lost its shell is one nothing on this Mac will ever clear:
-- they accumulate until they are dismissed by hand, one red button at a time, and ⌘W
-- does not do it — Close Session is disabled when there is no session, so the keystroke
-- just beeps. That is bc-30ve.
--
-- ## Why this needs none of the guards the signal does
--
-- lib/reap.js keeps four, and every one of them is about not killing an agent that is
-- still working. There is no agent here. A window with zero tabs holds no process, no
-- transcript and no scrollback — the thing those guards protect does not exist in it,
-- and there is no version of "this one was still busy" that can be true. So the test is
-- the whole of the safety argument: `(count of tabs) is 0`, and a window with any tab at
-- all is never touched.
--
-- ## Two passes, and that is not a style choice
--
-- Closing while iterating `windows` renumbers the collection underneath the loop, and
-- iTerm answers `Can't get item 12 of every window. Invalid index. (-1719)` partway
-- through — after it has closed some of them, which is the worst kind of half-done. So
-- the ids are collected first and closed second, addressed by id rather than by index,
-- each in its own `try` so one window that has gone away in the meantime does not cost
-- the rest.
--
-- Never launches iTerm: with iTerm not running there are no windows to close, and a
-- housekeeping sweep that started the terminal in order to tidy it would be worse than
-- the thing it tidies.
--
-- Prints the number closed, then their ids, space separated: `2 42590 42729`, or `0`.

on run
	if not (application id "com.googlecode.iterm2" is running) then return "0"

	tell application id "com.googlecode.iterm2"
		set doomed to {}
		repeat with w in windows
			try
				if (count of tabs of w) is 0 then set end of doomed to (id of w)
			end try
		end repeat

		set closedIds to {}
		repeat with theId in doomed
			try
				close (first window whose id is theId)
				set end of closedIds to (theId as text)
			end try
		end repeat
	end tell

	set AppleScript's text item delimiters to " "
	set out to ((count of closedIds) as text)
	if (count of closedIds) > 0 then set out to out & " " & (closedIds as text)
	set AppleScript's text item delimiters to ""
	return out
end run
