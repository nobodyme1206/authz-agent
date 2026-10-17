package sample.c02;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Param;
public interface Mapper {
    @Select("SELECT * FROM records WHERE id=#{id} AND owner_id=#{owner}")
    Object fetch(@Param("id") String id, @Param("owner") String owner);
}
