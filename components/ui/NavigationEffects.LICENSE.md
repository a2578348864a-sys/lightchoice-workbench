# S01 prototype attribution

The independent preview and the selected S01-B application integration contain the minimal pointer-relative gradient adaptation. No upstream library was installed. The application's two navigation shells retain their original routing and business handlers.

## Magic UI MagicCard — adapted pointer-relative gradient mechanism

Source: https://magicui.design/r/magic-card.json
Documentation: https://magicui.design/docs/components/magic-card
License: https://raw.githubusercontent.com/magicuidesign/magicui/main/LICENSE.md

MIT License

Copyright (c) Magic UI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Other studied components

shadcn Sidebar is MIT, copyright (c) 2023 shadcn. Its source was read; the existing LightChoice DOM/state handlers were retained, with equivalent local styling rather than importing its Provider, cookie model, Sheet, or dependencies.

coss Tooltip was read and demonstrated. A tiny preview-only body-level tooltip uses the existing accessible labels; Base UI was not installed or copied.

React Bits SpotlightCard (copyright (c) 2026 David Haz, MIT + Commons Clause) was read and demonstrated as a comparison. No React Bits source is imported into this preview. Ambient, grain and flare effects were deliberately not adopted.

Aceternity Sidebar was read and hovered. Hover-to-expand would change the required behavior, so its implementation was not copied.

BoardUI Sidebar is a visual composition reference only. Its public registry was read for study, but its code, Remix icons, React Aria components and internal dependencies are not imported.

21st SidebarShowcase is a comparison reference; no author source is copied. Square UI is a comparison reference only; no Square source is copied or redistributed in the preview implementation. Paid templates were neither obtained nor reverse engineered.
