-- 워크스페이스에 개별 노션 계정이 없고 공용 로그인(NINTLab) 하나만 있는 것을 확인함.
-- 팀원 식별은 전적으로 API 키 -> 이름 매핑으로 처리하므로 notion_user_id는 불필요해짐.
alter table team_members drop column notion_user_id;
