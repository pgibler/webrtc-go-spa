package broadcast

import (
	"context"
	"fmt"
	"strings"

	"github.com/redis/go-redis/v9"
)

// Store tracks which peers are currently broadcasting in a room.
type Store interface {
	Reset(ctx context.Context) error
	RemovePeer(ctx context.Context, id string) error
	SetBroadcast(ctx context.Context, id string, enabled bool) error
	Broadcasting(ctx context.Context) ([]string, error)
}

// RedisStore implements Store using a Redis set.
type RedisStore struct {
	rdb           *redis.Client
	keyBroadcasts string
}

// NewRedisStore builds a Store backed by Redis. Prefix is optional (e.g., "webrtc:room:abc123").
func NewRedisStore(rdb *redis.Client, prefix string) *RedisStore {
	p := strings.TrimSuffix(strings.TrimSpace(prefix), ":")
	if p == "" {
		p = "webrtc"
	}
	return &RedisStore{
		rdb:           rdb,
		keyBroadcasts: fmt.Sprintf("%s:broadcasting", p),
	}
}

func (s *RedisStore) Reset(ctx context.Context) error {
	return s.rdb.Del(ctx, s.keyBroadcasts).Err()
}

func (s *RedisStore) RemovePeer(ctx context.Context, id string) error {
	return s.rdb.SRem(ctx, s.keyBroadcasts, id).Err()
}

func (s *RedisStore) SetBroadcast(ctx context.Context, id string, enabled bool) error {
	if enabled {
		return s.rdb.SAdd(ctx, s.keyBroadcasts, id).Err()
	}
	return s.rdb.SRem(ctx, s.keyBroadcasts, id).Err()
}

func (s *RedisStore) Broadcasting(ctx context.Context) ([]string, error) {
	vals, err := s.rdb.SMembers(ctx, s.keyBroadcasts).Result()
	if err != nil {
		return nil, err
	}
	return vals, nil
}
