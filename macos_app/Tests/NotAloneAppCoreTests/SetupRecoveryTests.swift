import XCTest
import NotAloneAppCore

final class SetupRecoveryTests: XCTestCase {
    func testFailedUserSetupKeepsKnownUninitializedStateForManualRetry() throws {
        var recovery = SetupRecovery()
        recovery.connect(BackendConnection(address: "127.0.0.1:54321", token: "synthetic-token"))
        let query = try XCTUnwrap(recovery.beginQuery())
        XCTAssertTrue(recovery.finish(query, status: SetupStatus(
            initialized: false,
            ownerConfigured: false,
            credentialsConfigured: false
        )))
        let setup = try XCTUnwrap(recovery.beginSetup())
        XCTAssertTrue(recovery.finish(setup, status: nil))

        XCTAssertNil(recovery.beginQuery())
        XCTAssertNotNil(recovery.beginSetup())
    }

    func testOldFailedQueryCannotReplaceNewResult() throws {
        var recovery = SetupRecovery()
        recovery.connect(BackendConnection(address: "127.0.0.1:54321", token: "synthetic-token"))
        let failed = try XCTUnwrap(recovery.beginQuery())
        XCTAssertTrue(recovery.finish(failed, status: nil))
        let retry = try XCTUnwrap(recovery.beginQuery())

        XCTAssertFalse(recovery.finish(failed, status: SetupStatus(
            initialized: false,
            ownerConfigured: false,
            credentialsConfigured: false
        )))
        XCTAssertTrue(recovery.finish(retry, status: SetupStatus(
            initialized: true,
            ownerConfigured: true,
            credentialsConfigured: false
        )))
        XCTAssertFalse(recovery.isCurrent(failed))
        XCTAssertTrue(recovery.isCurrent(retry))
        XCTAssertNil(recovery.beginQuery())
    }

    func testFinishedQueryContinuationExpiresWhenConnectionChanges() throws {
        var recovery = SetupRecovery()
        recovery.connect(BackendConnection(address: "127.0.0.1:54321", token: "synthetic-token"))
        let finished = try XCTUnwrap(recovery.beginQuery())
        XCTAssertTrue(recovery.finish(finished, status: SetupStatus(
            initialized: true,
            ownerConfigured: true,
            credentialsConfigured: false
        )))
        XCTAssertTrue(recovery.isCurrent(finished))

        recovery.connect(BackendConnection(address: "127.0.0.1:54322", token: "replacement-token"))
        XCTAssertFalse(recovery.isCurrent(finished))
        XCTAssertNotNil(recovery.beginQuery())
    }

    func testDisconnectAndExitInvalidateQueriesEvenWhenSameConnectionReturns() throws {
        var recovery = SetupRecovery()
        let connection = BackendConnection(address: "127.0.0.1:54321", token: "synthetic-token")
        recovery.connect(connection)
        let disconnected = try XCTUnwrap(recovery.beginQuery())

        recovery.connect(nil)
        XCTAssertFalse(recovery.finish(disconnected, status: SetupStatus(
            initialized: true,
            ownerConfigured: true,
            credentialsConfigured: false
        )))
        XCTAssertFalse(recovery.isCurrent(disconnected))
        XCTAssertNil(recovery.beginQuery())

        recovery.connect(connection)
        let resumed = try XCTUnwrap(recovery.beginQuery())
        XCTAssertFalse(recovery.finish(disconnected, status: nil))
        XCTAssertTrue(recovery.finish(resumed, status: SetupStatus(
            initialized: true,
            ownerConfigured: true,
            credentialsConfigured: false
        )))
        XCTAssertTrue(recovery.isCurrent(resumed))

        recovery.connect(nil)
        XCTAssertFalse(recovery.isCurrent(resumed))
        XCTAssertNil(recovery.beginQuery())
    }

    func testUninitializedStatusWaitsForUserAndAllowsSetupCompletion() throws {
        var recovery = SetupRecovery()
        recovery.connect(BackendConnection(address: "127.0.0.1:54321", token: "synthetic-token"))
        let query = try XCTUnwrap(recovery.beginQuery())
        XCTAssertTrue(recovery.finish(query, status: SetupStatus(
            initialized: false,
            ownerConfigured: false,
            credentialsConfigured: false
        )))
        XCTAssertNil(recovery.beginQuery())

        let setup = try XCTUnwrap(recovery.beginSetup())
        XCTAssertNil(recovery.beginQuery())
        XCTAssertTrue(recovery.finish(setup, status: SetupStatus(
            initialized: true,
            ownerConfigured: true,
            credentialsConfigured: false
        )))
        XCTAssertNil(recovery.beginQuery())
        XCTAssertTrue(recovery.isCurrent(setup))
    }

    func testConnectionReplacementRejectsOldQueryAndItsContinuation() throws {
        var recovery = SetupRecovery()
        recovery.connect(BackendConnection(address: "127.0.0.1:54321", token: "synthetic-token"))
        let old = try XCTUnwrap(recovery.beginQuery())

        recovery.connect(BackendConnection(address: "127.0.0.1:54322", token: "replacement-token"))
        XCTAssertFalse(recovery.finish(old, status: SetupStatus(
            initialized: true,
            ownerConfigured: true,
            credentialsConfigured: false
        )))
        XCTAssertFalse(recovery.isCurrent(old))
        XCTAssertNotNil(recovery.beginQuery())
    }

    func testSuccessfulInitializedStatusStopsAutomaticQueries() throws {
        var recovery = SetupRecovery()
        recovery.connect(BackendConnection(address: "127.0.0.1:54321", token: "synthetic-token"))

        let query = try XCTUnwrap(recovery.beginQuery())
        XCTAssertTrue(recovery.finish(query, status: SetupStatus(
            initialized: true,
            ownerConfigured: true,
            credentialsConfigured: false
        )))
        XCTAssertNil(recovery.beginQuery())
        XCTAssertTrue(recovery.isCurrent(query))
    }

    func testInFlightQueryWaitsForResultBeforeRetrying() throws {
        var recovery = SetupRecovery()
        recovery.connect(BackendConnection(address: "127.0.0.1:54321", token: "synthetic-token"))

        let pending = try XCTUnwrap(recovery.beginQuery())
        XCTAssertNil(recovery.beginQuery())
        XCTAssertTrue(recovery.finish(pending, status: nil))
        XCTAssertNotNil(recovery.beginQuery())
    }

    func testFailedSetupQueryRetriesOnNextPollWithoutReattaching() throws {
        var recovery = SetupRecovery()
        recovery.connect(BackendConnection(address: "127.0.0.1:54321", token: "synthetic-token"))

        let first = try XCTUnwrap(recovery.beginQuery())
        XCTAssertTrue(recovery.finish(first, status: nil))

        let retry = try XCTUnwrap(recovery.beginQuery())
        XCTAssertTrue(recovery.finish(retry, status: SetupStatus(
            initialized: true,
            ownerConfigured: true,
            credentialsConfigured: false
        )))
        XCTAssertTrue(recovery.isCurrent(retry))
    }
}
