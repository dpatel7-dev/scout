# Changelog

## 1.3.0
- **Light or dark, set once for every app:** press **L** in pca (or `pca look light`, `pca look dark`, `pca look auto`). scout's window follows it (the sun/moon button still switches just this window).

## 1.2.2
- Night in the forest is bluer, like moonlight.

## 1.2.1
- The deer, rabbits and other animals in the forest walk forwards now (they were walking backwards).

## 1.2.0
- **A living pixel forest instead of the orange stripes.** In dark mode it's night: stars twinkle, the moon glows, mist drifts between the trees, fireflies blink, a shooting star goes by now and then, and an owl sits on a branch (and sometimes flies across). In light mode it's day: the sun, clouds drifting, falling leaves, butterflies, and a deer or a rabbit wandering through. The background stays plain white or black. The trees sway in the wind with the odd gust, and every so often a tree rustles and a bird flies off.
- It fades back while you're chatting, and holds still for people who turn on "reduce motion".

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
