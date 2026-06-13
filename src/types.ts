export interface Anchor {
  text: string;
  contextBefore: string;
  contextAfter: string;
}

export type Author = "user" | "ai" | string;

export interface Reply {
  author: Author;
  body: string;
  createdAt: string;
}

export interface Comment {
  id: string;
  anchor: Anchor;
  body: string;
  author: Author;
  createdAt: string;
  resolved: boolean;
  replies: Reply[];
}

