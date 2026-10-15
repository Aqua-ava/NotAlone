import CoreGraphics
import XCTest
@testable import NotAloneSyncCore

final class HeaderChangeTests: XCTestCase {
    func testWholeWindowOrScaledOutputCannotPassAsTheConfiguredTitleFrame() throws {
        XCTAssertNoThrow(try HeaderChangeGeometry.validateOutput(width: 800, height: 72,
            expectedWidth: 800, expectedHeight: 72))
        for size in [(1800, 1400), (400, 36), (800, 73), (0, 72)] {
            XCTAssertThrowsError(try HeaderChangeGeometry.validateOutput(width: size.0, height: size.1,
                expectedWidth: 800, expectedHeight: 72))
        }
    }

    func testDisplayCropStaysInTheUniqueWindowAndRejectsAmbiguousCoordinates() throws {
        let window = CGRect(x: 80, y: 100, width: 900, height: 700)
        let display = CGRect(x: 0, y: 0, width: 1920, height: 1080)
        let header = CGRect(x: 310, y: 12, width: 400, height: 36)
        let crop = try HeaderChangeGeometry.sourceRect(headerPixels: header, scale: 1,
            window: window, display: display)
        XCTAssertEqual(crop, CGRect(x: 390, y: 112, width: 400, height: 36))
        XCTAssertEqual(try HeaderChangeGeometry.sourceRect(headerPixels: CGRect(x: 620, y: 24, width: 800, height: 72),
            scale: 2, window: window, display: display), crop)
        for invalidWindow in [CGRect(x: -10, y: 100, width: 900, height: 700),
                              CGRect(x: 1500, y: 100, width: 900, height: 700)] {
            XCTAssertThrowsError(try HeaderChangeGeometry.sourceRect(headerPixels: header, scale: 1,
                window: invalidWindow, display: display))
        }
        for invalidHeader in [CGRect(x: 310, y: 140, width: 400, height: 36),
                              CGRect(x: -1, y: 12, width: 400, height: 36),
                              CGRect(x: 310, y: 12, width: 800, height: 36)] {
            XCTAssertThrowsError(try HeaderChangeGeometry.sourceRect(headerPixels: invalidHeader, scale: 1,
                window: window, display: display))
        }
        XCTAssertThrowsError(try HeaderChangeGeometry.sourceRect(headerPixels: header, scale: 1,
            window: window, display: CGRect(x: 1920, y: 0, width: 1920, height: 1080)))
    }

    func testOnlyMeaningfulTitlePixelsHintAndResetRequiresAFreshBaseline() throws {
        var detector = HeaderChangeDetector()
        let baseline = [UInt8](repeating: 240, count: 14400)
        XCTAssertFalse(try detector.accept(baseline, width: 400, height: 36))
        XCTAssertFalse(try detector.accept(baseline, width: 400, height: 36))
        var noise = baseline
        noise[0] = 0
        XCTAssertFalse(try detector.accept(noise, width: 400, height: 36))
        var title = baseline
        for pixel in 800..<880 { title[pixel] = 0 }
        XCTAssertTrue(try detector.accept(title, width: 400, height: 36))
        XCTAssertFalse(try detector.accept(title, width: 400, height: 36))
        detector.reset()
        XCTAssertFalse(try detector.accept(baseline, width: 400, height: 36))
        XCTAssertThrowsError(try detector.accept([0], width: 400, height: 36))
    }
}
