# Embed corpus

Every asset type the review surfaces have to render, in one document. Used by
`sharedEmbeds.test.ts` to pin that the markdown-it pipeline and the shared
asset resolvers agree about all of them.

## Images

A sibling image: ![sibling](screenshot.png)

A subdirectory image: ![nested](images/architecture.png)

A parent-relative image: ![parent](../diagrams/flow.png)

A workspace-absolute image: ![absolute](/media/logo.png)

An explicitly-relative image: ![dot slash](./inline.png)

A remote image: ![remote](https://example.com/hosted.png)

A protocol-relative image: ![protocol](//cdn.example.com/x.png)

An inline data image: ![data](data:image/png;base64,iVBORw0KGgo=)

## Mermaid

```mermaid
graph TD
  A[Review] --> B[Comment]
```

## PlantUML

```plantuml
@startuml
Human -> Claude: review this
@enduml
```

```puml
@startuml
Claude -> Human: opened 3 threads
@enduml
```

## Draw.io

A diagram link: ![architecture](diagrams/system.drawio)

## Not embeds

A fenced block that only looks like one:

```text
![not an image](never-resolved.png)
```

An inline `![code span](nope.png)` reference.

| Surface | Renderer |
|---|---|
| Inline comments | markdown-it |
| PR review | markdown-it |
| Live editor | Milkdown |
