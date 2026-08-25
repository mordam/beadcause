-- Close the iTerm2 window containing a session, addressed by its id or its tty.
--
-- lib/reap.js's closer for a window that opened and never ran its command
-- (bc-xl7n.113.3). `close-empty-windows.applescript` closes a window whose last tab has
-- already gone; this is its sibling for the window that never had a session tear its own
-- tab down in the first place, so the handle it is given still names a live session, not
-- an empty frame.
--
-- Closes the WINDOW, not the session inside it — `terminate` on a session leaves an empty
-- frame behind exactly as it did for the two windows caught in bc-30ve, and this exists
-- to end a leftover window rather than trade it for a different kind of one.
--
-- **Does no verification of its own.** Everything that decides whether it is safe to call
-- this — the tab still names the bead, no `claude` process on its tty — happens in Node,
-- against describe-session.applescript, before this ever runs. Closing is the one
-- irreversible act in the whole feature, so it is kept to the smallest thing that does
-- only that, with nothing here for a mistake in the decision to hide behind.
--
-- Prints `closed`, or `missing` when no session carries the handle any more.
--
-- Never launches iTerm: with iTerm not running there is no window to close.

on run argv
	set wantedId to item 1 of argv
	if not (application id "com.googlecode.iterm2" is running) then return "missing"

	tell application id "com.googlecode.iterm2"
		set targetWin to missing value
		repeat with w in windows
			repeat with t in tabs of w
				repeat with s in sessions of t
					if ((id of s) as text) is equal to wantedId or (tty of s) is equal to wantedId then
						set targetWin to id of w
						exit repeat
					end if
				end repeat
				if targetWin is not missing value then exit repeat
			end repeat
			if targetWin is not missing value then exit repeat
		end repeat
		if targetWin is missing value then return "missing"
		try
			close (first window whose id is targetWin)
		on error
			return "missing"
		end try
	end tell
	return "closed"
end run
