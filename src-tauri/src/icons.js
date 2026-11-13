ObjC.import('AppKit');
function run(argv) {
  const ws = $.NSWorkspace.sharedWorkspace;
  for (let i = 0; i + 1 < argv.length; i += 2) {
    try {
      const src = ws.iconForFile(argv[i]);
      const out = $.NSImage.alloc.initWithSize($.NSMakeSize(64, 64));
      out.lockFocus;
      src.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, 64, 64), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1);
      out.unlockFocus;
      const rep = $.NSBitmapImageRep.imageRepWithData(out.TIFFRepresentation);
      rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({})).writeToFileAtomically(argv[i + 1], true);
    } catch (e) {}
  }
}
