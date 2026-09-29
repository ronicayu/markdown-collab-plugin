### Claude as the reviewer

Right-click a `.md` file → **Ask Agent to Review This Doc**. You'll be asked
what to focus on — *"check the API examples"*, *"find marketing-y tone"* — or you
can leave it blank for a general pass.

Claude opens one thread per substantive concern, ranked by severity: the five
that matter most, plus one summary thread listing everything else so you can
ask for any of them ("open 3 and 7"). Say *"give me ten"* in the focus prompt
to raise the cap. Your sidebar is the triage queue, and **Next unread from
Claude** walks them in order.

Select several files (or a folder) and it's one pass over all of them, which is
how it catches the things a per-file review structurally can't — terminology
drift, a claim in one file contradicted by another.
