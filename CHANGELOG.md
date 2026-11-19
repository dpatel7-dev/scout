# Changelog

## 1.1.0
- **scout is a chat now.** Keep asking in the same conversation ("and how big is it?"), and find your old chats in the list on the left. Try again, copy, and stop are under each answer.
- **Paste anything.** Code, a table, JSON, notes, an essay, a whole file: it turns into a neat card (code is coloured, tables are tables, JSON is lined up). Press Enter with no question and Pip tidies it up and explains it, or ask about it ("find the bug", "who is oldest?"). The + button and dragging a file in work too.
- **Paste a link** and scout reads that page.
- **A new look:** a calm screen with warm light rising from the bottom, Pip in the middle and one box to type in. Light and dark.
- Under the box: **Search the web** (on by default; it skips the search for small talk and pastes), **Go deeper** (reads more websites and writes a fuller answer), and which AI answers.
- In Terminal: `pbpaste | scout` explains what you copied, and `cat notes.txt | scout fix my spelling` works on a file.

## 1.0.0
- scout is born. Ask a question; scout searches the web (DuckDuckGo, Wikipedia, or Brave with your
  own free key), reads the best pages at the same time, and writes a short, plain answer where every
  fact links to its website.
- In a window (`scout`): source cards, numbered citation chips in each site's own colour, follow-up
  questions, "People also want to know", your past questions, light and dark.
- In Terminal (`scout <question>`): the same answer, wrapped and coloured, with its sources.
- Set up free AI from the page itself: pick Groq, Gemini or OpenRouter, paste the key, done. Keys are
  shared with Tree of Thought, tidy and den.
