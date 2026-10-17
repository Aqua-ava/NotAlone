"""仅操作随机命名的自有目录；目录句柄与 NOFOLLOW 防止替换逃逸。"""

from contextlib import contextmanager, ExitStack
import errno
import os
from pathlib import Path
import stat
from typing import Any, Iterator
from uuid import UUID

from notalone.media.models import MediaError


DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


class ManagedMediaCache:
    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        if not self.root.is_absolute() or ".." in self.root.parts:
            raise MediaError("unsafe_cache")

    @contextmanager
    def directory(
        self, parts: tuple[str, ...], *, create: bool = False,
    ) -> Iterator[int]:
        fd = os.open("/", DIRECTORY_FLAGS)
        try:
            root_parts = self.root.parts[1:]
            for index, part in enumerate((*root_parts, *parts)):
                if create:
                    try:
                        os.mkdir(part, 0o700, dir_fd=fd)
                    except FileExistsError:
                        pass
                child = os.open(part, DIRECTORY_FLAGS, dir_fd=fd)
                os.close(fd)
                fd = child
                if index >= len(root_parts) - 1:
                    info = os.fstat(fd)
                    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
                        raise MediaError("unsafe_cache")
            yield fd
        finally:
            os.close(fd)

    @staticmethod
    def parts(row: dict[str, Any]) -> tuple[str, ...]:
        return tuple(
            UUID(str(row[key])).hex for key in
            ("owner_id", "contact_id", "source_document_id", "attempt_id")
        )

    @contextmanager
    def staging(self, row: dict[str, Any]) -> Iterator[int]:
        with self.directory(self.parts(row), create=True) as fd:
            yield fd

    @staticmethod
    def write(fd: int, artifact_id: UUID, data: bytes) -> None:
        output = os.open(
            artifact_id.hex + ".part",
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600, dir_fd=fd,
        )
        with os.fdopen(output, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())

    @staticmethod
    def publish(fd: int, artifact_id: UUID) -> None:
        os.rename(
            artifact_id.hex + ".part", artifact_id.hex + ".data",
            src_dir_fd=fd, dst_dir_fd=fd,
        )
        os.fsync(fd)

    def read(self, row: dict[str, Any], artifact: dict[str, Any]) -> bytes:
        with self.directory(self.parts(row)) as fd:
            source = os.open(
                UUID(artifact["artifact_id"]).hex + ".data",
                os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd,
            )
            with os.fdopen(source, "rb") as stream:
                info = os.fstat(stream.fileno())
                if (
                    not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                    or info.st_size != artifact["size"]
                ):
                    raise MediaError("resource_missing")
                return stream.read(artifact["size"] + 1)

    def cleanup(self, row: dict[str, Any]) -> None:
        parts = self.parts(row)
        with ExitStack() as stack:
            try:
                fd = stack.enter_context(self.directory(parts))
            except FileNotFoundError:
                return
            for name in os.listdir(fd):
                try:
                    os.unlink(name, dir_fd=fd)
                except FileNotFoundError:
                    # 其他清理者只移除单项时，仍须清完余项并验证目录消失。
                    continue
            os.fsync(fd)
        for length in range(len(parts), 0, -1):
            try:
                with self.directory(parts[:length-1]) as parent:
                    os.rmdir(parts[length-1], dir_fd=parent)
            except FileNotFoundError:
                continue
            except OSError as error:
                # attempt 必须确实移除；只有祖先可以因兄弟资源仍在而保留。
                if error.errno == errno.ENOTEMPTY and length < len(parts):
                    break
                raise
