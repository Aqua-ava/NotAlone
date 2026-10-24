import Foundation
import Security

@main
private struct EntitlementReadProbe {
    static func main() {
        let key = "com.apple.developer.background-tasks.continued-processing.inference"
        guard let task = SecTaskCreateFromSelf(nil),
              let value = SecTaskCopyValueForEntitlement(task, key as CFString, nil) else {
            print("background_inference=false")
            exit(1)
        }
        print("background_inference=\(value)")
        exit(
            CFGetTypeID(value) == CFBooleanGetTypeID()
                && CFBooleanGetValue((value as! CFBoolean)) ? 0 : 1
        )
    }
}
