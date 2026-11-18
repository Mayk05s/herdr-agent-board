// The texts of the board's own server's state (core/system-state.ts, GET /api/system): the head's
// chip, Settings → Server… and its panel, in English and Russian; strings.ts merges them into the
// dictionaries.
import type { Lang } from '../types.ts'

export const SYSTEM_STRINGS: Record<Lang, Record<string, string | string[]>> = {
  en: {
    'set.server': 'Server…',
    'sys.title': 'Server',
    'sys.about': '{host} · up {uptime}',
    'sys.aboutHost': '{host}',
    'sys.loading': 'Reading the server’s state…',
    'sys.loadError': 'Could not read the server’s state: {error}',
    'sys.stale': 'Not updated: {error}',
    'sys.chipHint': 'The server now: CPU, memory and its fullest disk. Opens its state',

    'sys.chip.cpu': 'CPU',
    'sys.chip.ram': 'RAM',
    'sys.chip.disk': 'Disk {mount}',

    'sys.cpu': 'CPU',
    'sys.cpu.cores': ['{n} core', '{n} cores'],
    'sys.cpu.load': 'load average {one} · {five} · {fifteen}',
    'sys.cpu.loadHint': 'Processes running or waiting, averaged over 1, 5 and 15 minutes',
    'sys.cpu.first': 'Measured at the next reading',

    'sys.memory': 'Memory',
    'sys.swap': 'Swap',
    'sys.noSwap': 'No swap',
    'sys.total': 'total {size}',
    'sys.used': 'used {size}',
    'sys.available': 'available {size}',
    'sys.cache': 'buffers and cache {size}',

    'sys.disks': 'Disks',
    'sys.noDisks': 'No disk to show.',
    'sys.disk.of': '{device} · {fs}',

    'sys.gpu': 'GPU',
    'sys.gpu.loadOf': 'load',
    'sys.gpu.load': 'load {pct}',
    'sys.gpu.memory': 'memory {used} of {total}',
    'sys.gpu.temp': '{deg} °C',

    'sys.topCpu': 'Most CPU',
    'sys.topCpuHint': 'Percent of one core since the reading before, as top counts it',
    'sys.topMemory': 'Most memory',
    'sys.topNone': 'Nothing took CPU since the reading before.',
    'sys.topFirst': 'Shown from the next reading.',
    'sys.proc.pid': 'pid {pid}',
    'sys.proc.cpu': 'CPU',
    'sys.proc.memory': 'Memory',

    'sys.label.board': 'the board',
    'sys.label.herdr': 'herdr',
    'sys.label.browser': 'browser :{display}',
    'sys.label.vnc': 'desktop :{display}',
    'sys.label.video': 'video :{display}',

    'sys.uptime.days': ['{n} day {h} h', '{n} days {h} h'],
    'sys.uptime.hours': '{h} h {m} min',
    'sys.uptime.minutes': '{m} min',

    'sys.unit.B': '{n} B',
    'sys.unit.KiB': '{n} KiB',
    'sys.unit.MiB': '{n} MiB',
    'sys.unit.GiB': '{n} GiB',
    'sys.unit.TiB': '{n} TiB',
  },
  ru: {
    'set.server': 'Сервер…',
    'sys.title': 'Сервер',
    'sys.about': '{host} · работает {uptime}',
    'sys.aboutHost': '{host}',
    'sys.loading': 'Читаю состояние сервера…',
    'sys.loadError': 'Не удалось прочитать состояние сервера: {error}',
    'sys.stale': 'Не обновляется: {error}',
    'sys.chipHint': 'Сервер сейчас: процессор, память и самый заполненный диск. Открывает его состояние',

    'sys.chip.cpu': 'CPU',
    'sys.chip.ram': 'RAM',
    'sys.chip.disk': 'Диск {mount}',

    'sys.cpu': 'Процессор',
    'sys.cpu.cores': ['{n} ядро', '{n} ядра', '{n} ядер'],
    'sys.cpu.load': 'средняя нагрузка {one} · {five} · {fifteen}',
    'sys.cpu.loadHint': 'Процессы, что работают или ждут, в среднем за 1, 5 и 15 минут',
    'sys.cpu.first': 'Измерится при следующем замере',

    'sys.memory': 'Память',
    'sys.swap': 'Подкачка',
    'sys.noSwap': 'Подкачки нет',
    'sys.total': 'всего {size}',
    'sys.used': 'занято {size}',
    'sys.available': 'доступно {size}',
    'sys.cache': 'буферы и кэш {size}',

    'sys.disks': 'Диски',
    'sys.noDisks': 'Дисков для показа нет.',
    'sys.disk.of': '{device} · {fs}',

    'sys.gpu': 'Видеокарта',
    'sys.gpu.loadOf': 'загрузка',
    'sys.gpu.load': 'загрузка {pct}',
    'sys.gpu.memory': 'память {used} из {total}',
    'sys.gpu.temp': '{deg} °C',

    'sys.topCpu': 'Больше всего процессора',
    'sys.topCpuHint': 'Процент одного ядра с прошлого замера, как считает top',
    'sys.topMemory': 'Больше всего памяти',
    'sys.topNone': 'С прошлого замера процессор никто не занимал.',
    'sys.topFirst': 'Появится при следующем замере.',
    'sys.proc.pid': 'pid {pid}',
    'sys.proc.cpu': 'CPU',
    'sys.proc.memory': 'Память',

    'sys.label.board': 'доска',
    'sys.label.herdr': 'herdr',
    'sys.label.browser': 'браузер :{display}',
    'sys.label.vnc': 'рабочий стол :{display}',
    'sys.label.video': 'видео :{display}',

    'sys.uptime.days': ['{n} день {h} ч', '{n} дня {h} ч', '{n} дней {h} ч'],
    'sys.uptime.hours': '{h} ч {m} мин',
    'sys.uptime.minutes': '{m} мин',

    'sys.unit.B': '{n} Б',
    'sys.unit.KiB': '{n} КБ',
    'sys.unit.MiB': '{n} МБ',
    'sys.unit.GiB': '{n} ГБ',
    'sys.unit.TiB': '{n} ТБ',
  },
}
