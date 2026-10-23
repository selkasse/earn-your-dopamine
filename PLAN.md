# UI/UX Alignment Fix for Warning Badges

The layout for the "Warning Badges" section is now on a single line, which is great, but the varying lengths of the text labels ("Show yellow warning at:" vs "Show red warning at:") are causing the input boxes to be vertically misaligned. It looks jagged.

Please update the CSS for this specific section to ensure perfect vertical alignment of the input boxes and trailing text.

test update. agent ignore this line

**Instructions:**

1. Wrap the two warning badge rows in a dedicated container if they aren't already.
2. Apply a CSS Grid layout to this container to act like a 3-column table:
   - `display: grid;`
   - `grid-template-columns: max-content 60px max-content;` (or similar, adjusting the middle column for the input box width).
   - `align-items: center;`
   - `row-gap: 12px;`
   - `column-gap: 8px;`
3. Ensure the elements fall into the grid properly:
   - Column 1: The text labels ("Show yellow warning at:", "Show red warning at:") - set their text alignment to `right` so they hug the input boxes.
   - Column 2: The number inputs.
   - Column 3: The trailing text ("minutes left").
4. Alternatively, if keeping Flexbox is easier for the current DOM structure, enforce a strict `width` (e.g., `width: 170px; text-align: right;`) on the text labels so they push the input boxes to the exact same vertical X-coordinate.
5. Verify that the input boxes are perfectly stacked on top of each other, then continue the autonomous loop.
