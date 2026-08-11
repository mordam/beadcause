-- Open a new iTerm2 window and type a command into it.
--
-- Everything arrives through `argv` rather than being interpolated into the script
-- text. That matters: the command carries a shell-quoted path and a bead id that
-- originate in an HTTP request, and AppleScript string escaping is its own separate
-- minefield on top of shell quoting. With argv there is only one layer to get right,
-- and Node owns it.
--
-- Addressed by bundle id because the app is called "iTerm" on disk but "iTerm2"
-- everywhere else, and which name the scripting bridge answers to has changed
-- between versions.
--
-- argv, in order. Everything after the first two is optional, and an empty string means
-- "as it was before any of this existed" — which is what an older caller passes, and
-- what every failure below degrades to:
--
--   1. the command to type
--   2. the tab name
--   3. the profile to open with, or "" for iTerm's default profile
--   4. the window's bounds as "left,top,right,bottom", or "" to let iTerm cascade
--   5. "return-focus" to hand the keyboard back, anything else to take it
--
-- ## Why the geometry is four integers and not a position and a size
--
-- iTerm's dictionary advertises `position`, `size`, `origin` and `frame` on a window.
-- On 3.6.11 every one of them raises -10000 the moment it is read or written; `bounds`
-- is the only geometry property whose handler actually works. So one rectangle, set in
-- one statement, and no arithmetic on this side of the boundary.
--
-- ## Why the focus dance
--
-- iTerm brings itself to the front and makes a new window key whether or not anybody
-- said `activate` — that was measured, not assumed: with iTerm not frontmost, `create
-- window` alone leaves it frontmost with the new window taking keystrokes. There is no
-- flag anywhere in the AppleScript or Python APIs for creating a window in the
-- background, and `set frontmost of <window> to true` raises -10000 like the rest of
-- them. What *does* work is giving the keyboard back: `select` on the window that had it
-- before, after a beat long enough for iTerm to have finished stealing it.
--
-- So the honest description is that focus is borrowed rather than never taken. A
-- keystroke typed in the half-second while the window is coming up still lands in it.
-- What this removes is the far worse case — the window that keeps focus, so the rest of
-- the sentence you were typing goes into a fresh agent session's prompt.

on run argv
	set theCommand to item 1 of argv
	set theName to item 2 of argv
	set theProfile to ""
	set theBounds to ""
	set returnFocus to false
	if (count of argv) > 2 then set theProfile to item 3 of argv
	if (count of argv) > 3 then set theBounds to item 4 of argv
	if (count of argv) > 4 then set returnFocus to (item 5 of argv is "return-focus")

	-- Parse the rectangle out here, before the tell block. `text item delimiters` is a
	-- property of AppleScript itself, and setting it inside `tell application` makes
	-- iTerm the target: it answers -10006 "can't set text item delimiters", which is a
	-- confusing way to fail to open a window.
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
			-- A rectangle that would not parse is a rectangle not applied. Nothing else
			-- about the session depends on it.
			set rect to {}
		end try
	end if

	tell application id "com.googlecode.iterm2"
		-- Only when the window is meant to end up in front. `activate` is not what
		-- steals focus — see above — but there is no reason to raise the whole app over
		-- whatever you are doing when the point is to leave you alone.
		if not returnFocus then activate

		-- Whoever had the keyboard, so it can be handed back. `missing value` when iTerm
		-- had no window at all, which is the ordinary first-session-of-the-day case.
		set priorWindow to missing value
		try
			set priorWindow to current window
		end try

		set newWindow to missing value
		if theProfile is not "" then
			try
				set newWindow to (create window with profile theProfile)
			on error
				-- The profile is written by the daemon a moment before this runs, and
				-- iTerm loads it from a directory it watches — so the very first session
				-- after an upgrade can arrive before iTerm has noticed the file. That is
				-- a window with the wrong scrollback for one launch, not a failure.
				set newWindow to missing value
			end try
		end if
		if newWindow is missing value then set newWindow to (create window with default profile)

		if (count of rect) is 4 then
			try
				set bounds of newWindow to rect
			end try
		end if

		tell current session of newWindow
			-- The tab title. Claude renames its own session on the first turn;
			-- this is what labels the window until it does.
			set name to theName
			write text theCommand
			-- The session's own id, kept for the caller.
			--
			-- It is the only durable handle on this window: the tab name is gone the
			-- moment Claude renames itself, and the pid belongs to the shell rather
			-- than to iTerm. scripts/message-session.applescript takes this id back,
			-- which is what lets the daemon say something to a session it started —
			-- see `messageSession` in lib/session.js.
			set theId to id
		end tell

		if returnFocus and priorWindow is not missing value then
			-- The beat is load-bearing. Without it `select` loses the race against
			-- iTerm's own activation and the new window simply keeps the keyboard;
			-- measured at 0.4s, which is comfortably clear of it.
			delay 0.4
			try
				select priorWindow
			end try
		end if

		return theId
	end tell
end run
