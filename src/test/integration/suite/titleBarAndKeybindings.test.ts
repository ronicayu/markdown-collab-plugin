// Coverage gap 5 (round-4 coverage review of 0.35.16-0.35.17): the review
// view's rename to "Markdown Collab" branding touched three separate
// manifest entries (the command title, the custom editor's displayName, and
// the Comment Threads view's name). Nothing asserted the exact strings, so a
// future edit could silently drift one of them back toward the old wording
// or reintroduce a category. Manifest-level only — no extension activation
// needed — but lives alongside the other integration suites per this round's
// file ownership.

import * as assert from "assert";
import { readFileSync } from "fs";
import * as path from "path";

interface CommandContribution {
  command: string;
  title: string;
  category?: string;
  icon?: string;
}

interface CustomEditorContribution {
  viewType: string;
  displayName: string;
}

interface ViewContribution {
  id: string;
  name: string;
}

function loadPackageJson(): {
  contributes: {
    commands: CommandContribution[];
    customEditors: CustomEditorContribution[];
    views: Record<string, ViewContribution[]>;
  };
} {
  const pkgPath = path.resolve(__dirname, "..", "..", "..", "..", "package.json");
  return JSON.parse(readFileSync(pkgPath, "utf-8"));
}

suite("Title bar and keybindings — rename assertions", () => {
  const pkg = loadPackageJson();

  test("openInlineCommentsView's title is exactly \"Open in Markdown Collab\", no category", () => {
    const command = pkg.contributes.commands.find(
      (c) => c.command === "markdownCollab.openInlineCommentsView",
    );
    assert.ok(command, "markdownCollab.openInlineCommentsView is not contributed");
    assert.strictEqual(command!.title, "Open in Markdown Collab");
    assert.strictEqual(command!.category, undefined, `unexpected category: ${command!.category}`);
  });

  test("the markdownCollab.collabEditor custom editor's displayName is exactly \"Markdown Collab\"", () => {
    const editor = pkg.contributes.customEditors.find((e) => e.viewType === "markdownCollab.collabEditor");
    assert.ok(editor, "markdownCollab.collabEditor custom editor is not contributed");
    assert.strictEqual(editor!.displayName, "Markdown Collab");
  });

  test("the markdownCollab.review view is named exactly \"Comment Threads\"", () => {
    const allViews = Object.values(pkg.contributes.views).flat();
    const view = allViews.find((v) => v.id === "markdownCollab.review");
    assert.ok(view, "markdownCollab.review view is not contributed");
    assert.strictEqual(view!.name, "Comment Threads");
  });
});
