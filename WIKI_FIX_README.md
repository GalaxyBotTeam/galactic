# Wiki Fix Instructions

This directory contains a patch file to fix broken links in the GitHub wiki.

## The Problem
The wiki contained a broken placeholder link:
- **Location**: Standalone Instance.md, line 48
- **Broken URL**: `https://github.com/youruser/galactic/issues`
- **This led to**: 404 error page

## The Solution
The link has been corrected to point to the actual repository:
- **Correct URL**: `https://github.com/GalaxyBotTeam/galactic.ts/issues`

## Applying the Fix

### Option 1: Manual Edit
1. Navigate to the wiki: https://github.com/GalaxyBotTeam/galactic.ts/wiki
2. Edit the "Standalone Instance" page
3. Find line 48: `If you have questions or want to contribute, visit [GitHub discussions or the issue tracker](https://github.com/youruser/galactic/issues).`
4. Replace `youruser/galactic` with `GalaxyBotTeam/galactic.ts`
5. Save the changes

### Option 2: Using Git Patch
1. Clone the wiki repository:
   ```bash
   git clone https://github.com/GalaxyBotTeam/galactic.ts.wiki.git
   cd galactic.ts.wiki
   ```

2. Apply the patch:
   ```bash
   git apply /path/to/wiki-fix.patch
   ```

3. Commit and push:
   ```bash
   git add "Standalone Instance.md"
   git commit -m "Fix broken link: Replace placeholder URL with correct repository"
   git push
   ```

## Verification
After applying the fix, verify all GitHub links in the wiki point to the correct repository:
- ✅ Home.md - Links are correct
- ✅ Standalone Instance.md - Link fixed
- ✅ Other wiki pages - Links are correct
