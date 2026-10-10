"""Offline group sampling. No text patterns or live routing rules."""


def sample_epoch(rows, rng, mode='group'):
    assert mode in ('group', 'group-class')
    groups = {}
    for index, row in enumerate(rows):
        assert isinstance(row['request'], bool) and isinstance(row['ready'], bool)
        assert not row['ready'] or row['request']
        group = row.get('sourceGroup', row.get('sourceCase', index))
        label = 2 if row['ready'] else 1 if row['request'] else 0
        key = (group, label) if mode == 'group-class' else group
        groups.setdefault(key, []).append(index)
    selected = [rng.choice(indices) for indices in groups.values()]
    rng.shuffle(selected)
    return selected
