# Marker Format

A code sample containing what looks like a real marker must never be
treated as one. Both of the blocks below are decoys.

```markdown
Some prose <!--mc:a:fake1-->anchored<!--mc:/a:fake1--> here.

<!--mc:threads:begin-->
<!--mc:t {"id":"fake1","quote":"anchored","status":"open","comments":[]}-->
<!--mc:threads:end-->
```

Inline decoys work the same way: `<!--mc:a:fake2-->` is just text, and so
is `<!--mc:threads:begin-->` when it sits in a code span.

    <!--mc:a:fake3-->indented code is a decoy too<!--mc:/a:fake3-->

Real prose resumes here and is a legitimate anchor target.

## Escaping

A comment body containing the sequence that would close an HTML comment
must survive a round trip, as must one containing an opening sequence.
