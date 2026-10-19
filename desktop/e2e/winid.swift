// Prints the CGWindowID of the first on-screen window owned by a process
// whose name contains the argument. Used by shots.sh for screencapture -l.
import CoreGraphics
let opts = CGWindowListOption(arrayLiteral: .optionOnScreenOnly)
if let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] {
  for w in list {
    let owner = w[kCGWindowOwnerName as String] as? String ?? ""
    let layer = w[kCGWindowLayer as String] as? Int ?? 0
    if layer == 0 && owner.contains(CommandLine.arguments[1]) { print(w[kCGWindowNumber as String] as! Int); break }
  }
}
