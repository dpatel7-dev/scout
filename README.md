# scout

**Ask anything. scout searches the web, reads the best pages, and explains what it found in plain words.**
Every fact has a little number you can click to see the website it came from.

Pip the owl does the reading.

```
  scout  how do noise cancelling headphones work

  Tiny microphones listen to the noise around you, and the headphones play the
  exact opposite sound, so the two cancel out. [1][2]

  • It works best on steady sounds like plane engines and fans. [1]
  • Sudden sounds, like voices, get through more. [3]

  Sources
  [1] How Noise Cancelling Works - Sony
  [2] Active noise control - Wikipedia
  [3] ...
```

## Get it

On a Mac, open **Terminal** (press Command + Space, type `Terminal`, press Enter), paste this line, and press Enter:

```sh
curl -fsSL https://djp7.pythonanywhere.com/scout/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://djp7.pythonanywhere.com/scout/install.ps1 | iex
```

Or open **Project CLI Access** (`pca`) and pick Pip's card.

## Use it

| To | Type |
| --- | --- |
| Open scout in a window, and type questions there | `scout` |
| Get an answer right in Terminal | `scout why is the sky blue` |
| Get the newest scout | `scout update` |

In the window: type a question and press Enter. Click a numbered chip to open that website.
"People also want to know" has questions you can ask next with one click, and the box at the
bottom takes follow-ups ("and how much does it cost?").

## The AI

scout needs a free AI to read and explain. If you use Tree of Thought, tidy or den, it's already
set up. If not, the first time you ask, scout shows a box: pick **Groq** (the quickest), open the
key page, copy the key, paste it in, click Save. That's all.

## How it searches

- DuckDuckGo and Wikipedia, with no key.
- A free [Brave Search](https://brave.com/search/api/) key (Settings) makes results steadier.

scout only talks to the search engines, the websites it reads, and your AI. Your past questions
stay on your computer (`~/.scout`); clear them in Settings.
