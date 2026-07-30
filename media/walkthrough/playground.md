### What you're looking at

```markdown
The <!--mc:a:k7q3p-->quick brown fox<!--mc:/a:k7q3p--> jumps…

<!--mc:threads:begin-->
<!--mc:t {"id":"k7q3p","quote":"quick brown fox","status":"open",
  "comments":[{"id":"c1","author":"you","ts":"…","body":"too cliched"}]}-->
<!--mc:threads:end-->
```

Two paired HTML comments wrap the text a thread points at, and the threads
themselves live in one block at the end of the file. Both are invisible in every
rendered view — GitHub, your docs site, anyone's preview.

That is the whole storage design. Review state travels with the document.
