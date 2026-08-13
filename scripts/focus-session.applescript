-- Bring the iTerm2 window showing a session to the front, and/or set its bounds.
--
-- The one thing `/session?pid=…` could not do. It can tail a session's transcript and
-- type into it, but on a Mac with a dozen worktree windows open, finding the window you
-- are reading about meant hunting iTerm's window list by hand. This is the other end of
-- that: from the phone, point the Mac at it.
--
-- **The same two kinds of handle as message-session.applescript**, for the same reason:
-- the advocate knows the iTerm session id of every worker it opened, and a session
-- started at the keyboard has no id anywhere but does have a controlling terminal. So
-- `/dev/ttysNNN` is matched against `tty of s` as well. See `sessionReach` in
-- lib/session.js. The two cannot collide — an id is a UUID, a tty starts with a slash.
--
-- argv, in order:
--
--   1. the handle — an iTerm session id, or a `/dev/ttysNNN` path
--   2. the bounds to set, as "left,top,right,bottom", or "" to leave the window's size
--      and position exactly as they are
--   3. "front" to raise iTerm and select the window, anything else to touch nothing
--      about focus
--
-- **It always prints the bounds it found, before it changed anything** — that reading is
-- the whole of how the window gets put back afterwards, and it has to be taken in the
-- same call that enlarges it or a second call would read the enlarged rectangle and save
-- *that* as the thing to restore to. `missing` when no session carries the handle, which
-- is the answer to "is that window still there" and the only honest way to learn it.
--
-- **Geometry is one rectangle set as `bounds`.** iTerm's dictionary advertises
-- `position`, `size`, `origin` and `frame` on a window and every one of them raises
-- -10000 on 3.6.11; `bounds` is the only geometry property whose handler works. Reaching
-- for the others is the obvious refactor and it silently stops moving windows. Same rule
-- as scripts/open-session.applescript, and it is checked by test/cards.mjs.
--
-- **`activate` and `select`, both.** `activate` raises iTerm over whatever else is on
-- screen; `select` picks the right window out of iTerm's own stack. Neither alone is
-- enough — activate leaves you on iTerm's last window, select leaves iTerm behind Chrome
-- — and unlike open-session.applescript there is no beat to wait out, because nothing
-- here is racing iTerm's own activation of a window it just created.
--
-- **It never launches iTerm.** `is running` is a question, not a use. A daemon that
-- opened the terminal in order to find out nobody was there has already made the answer
-- wrong.

on run argv
	set wantedId to item 1 of argv
	set theBounds to ""
	set bringFront to false
	if (count of argv) > 1 then set theBounds to item 2 of argv
	if (count of argv) > 2 then set bringFront to (item 3 of argv is "front")

	-- Parsed out here, before the tell block. `text item delimiters` belongs to
	-- AppleScript itself, and setting it inside `tell application` makes iTerm the
	-- target: it answers -10006, which is a confusing way to fail to move a window.
	set rect to {}
	if theBounds is not "" then
		set AppleScript's text item delimiters to ","
		set parts to text items of theBounds
		set AppleScript's text item delimiters to ""
		try
			repeat with piece in parts
				set end of rect to (piece as integer)
			end repeat
		on error
			-- A rectangle that would not parse is a rectangle not applied. The reading
			-- below still goes back, so the caller learns where the window is.
			set rect to {}
		end try
	end if

	if not (application id "com.googlecode.iterm2" is running) then return "missing"

	set found to {}
	tell application id "com.googlecode.iterm2"
		-- Find the window's own id first, and act through `window id` afterwards.
		--
		-- Not the loop's reference: `repeat with w in windows` hands you
		-- `item N of every window`, which is a position in a list that `activate` is
		-- allowed to reorder — so acting through it could move a different window than
		-- the one that was found. `contents of w` does not rescue it either; iTerm
		-- answers -1728 for that. The id is stable for the life of the window.
		set targetId to missing value
		repeat with w in windows
			repeat with t in tabs of w
				repeat with s in sessions of t
					if ((id of s) as text) is equal to wantedId or (tty of s) is equal to wantedId then
						set targetId to id of w
						exit repeat
					end if
				end repeat
				if targetId is not missing value then exit repeat
			end repeat
			if targetId is not missing value then exit repeat
		end repeat

		if targetId is not missing value then
			-- Read before anything is set. This is the record the restore depends on.
			set found to bounds of window id targetId
			if bringFront then
				activate
				try
					select window id targetId
				end try
			end if
			if (count of rect) is 4 then
				try
					set bounds of window id targetId to rect
				end try
			end if
		end if
	end tell

	if (count of found) is not 4 then return "missing"

	set AppleScript's text item delimiters to ","
	set out to found as text
	set AppleScript's text item delimiters to ""
	return out
end run
